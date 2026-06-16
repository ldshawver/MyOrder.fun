import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, visualEditorPageVersionsTable, visualEditorPagesTable } from "@workspace/db";
import { loadDbUser, normalizeRole, requireApproved, requireAuth, requireDbUser, requireRole, writeAuditLog } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";

const router: IRouter = Router();

const ALLOWED_COMPONENTS = new Set([
  "HeroSection", "TextBlock", "ImageBlock", "CTAButton", "ProductPromoGrid", "FAQBlock", "FeatureGrid",
  "AnnouncementBanner", "ContactInfoBlock", "StoreHoursBlock", "CatalogSection", "FeaturedProductsBlock",
]);
const RESERVED_SLUGS = new Set(["admin", "api", "app", "checkout", "cart", "login", "logout", "orders", "settings", "inventory", "shifts", "payments"]);
const MAX_LAYOUT_BYTES = 250_000;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;
const emptyPuckData = { root: { props: {} }, content: [] };
let schemaEnsured = false;

const dataSchema = z.object({ root: z.record(z.string(), z.unknown()).optional(), content: z.array(z.unknown()), zones: z.record(z.string(), z.unknown()).optional() }).strict();
const createPageSchema = z.object({ slug: z.string().trim().toLowerCase(), title: z.string().trim().min(1).max(140), draftJson: z.unknown().optional() }).strict();
const draftSchema = z.object({ draftJson: z.unknown() }).strict();
const restoreSchema = z.object({ versionId: z.number().int().positive() }).strict();

async function ensureVisualEditorSchema(): Promise<void> {
  if (schemaEnsured) return;
  const statements = [
    sql`CREATE TABLE IF NOT EXISTS "visual_editor_pages" (
      "id" serial PRIMARY KEY NOT NULL,
      "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
      "company_id" integer REFERENCES "tenants"("id"),
      "slug" text NOT NULL,
      "title" text NOT NULL,
      "draft_json" jsonb NOT NULL DEFAULT '{"root":{"props":{}},"content":[]}'::jsonb,
      "published_json" jsonb,
      "status" text NOT NULL DEFAULT 'draft',
      "created_by_user_id" integer REFERENCES "users"("id"),
      "updated_by_user_id" integer REFERENCES "users"("id"),
      "published_by_user_id" integer REFERENCES "users"("id"),
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      "published_at" timestamp with time zone,
      "archived_at" timestamp with time zone
    )`,
    sql`ALTER TABLE "visual_editor_pages" ADD COLUMN IF NOT EXISTS "company_id" integer REFERENCES "tenants"("id")`,
    sql`ALTER TABLE "visual_editor_pages" ADD COLUMN IF NOT EXISTS "draft_json" jsonb NOT NULL DEFAULT '{"root":{"props":{}},"content":[]}'::jsonb`,
    sql`ALTER TABLE "visual_editor_pages" ADD COLUMN IF NOT EXISTS "published_json" jsonb`,
    sql`ALTER TABLE "visual_editor_pages" ADD COLUMN IF NOT EXISTS "created_by_user_id" integer REFERENCES "users"("id")`,
    sql`ALTER TABLE "visual_editor_pages" ADD COLUMN IF NOT EXISTS "updated_by_user_id" integer REFERENCES "users"("id")`,
    sql`ALTER TABLE "visual_editor_pages" ADD COLUMN IF NOT EXISTS "published_by_user_id" integer REFERENCES "users"("id")`,
    sql`ALTER TABLE "visual_editor_pages" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone`,
    sql`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='visual_editor_pages' AND column_name='draft_data') THEN
          EXECUTE 'UPDATE "visual_editor_pages" SET "draft_json" = COALESCE("draft_json", "draft_data")';
        END IF;
      END $$`,
    sql`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='visual_editor_pages' AND column_name='published_data') THEN
          EXECUTE 'UPDATE "visual_editor_pages" SET "published_json" = COALESCE("published_json", "published_data")';
        END IF;
      END $$`,
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "visual_editor_pages_tenant_slug_unique" ON "visual_editor_pages" ("tenant_id", "slug")`,
    sql`CREATE TABLE IF NOT EXISTS "visual_editor_page_versions" (
      "id" serial PRIMARY KEY NOT NULL,
      "page_id" integer NOT NULL REFERENCES "visual_editor_pages"("id") ON DELETE CASCADE,
      "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
      "company_id" integer REFERENCES "tenants"("id"),
      "version_json" jsonb NOT NULL,
      "title" text NOT NULL,
      "slug" text NOT NULL,
      "created_by_user_id" integer REFERENCES "users"("id"),
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )`,
  ];
  for (const statement of statements) await db.execute(statement);
  schemaEnsured = true;
}

function validateSlug(slug: string): string | null {
  const normalized = slug.trim().toLowerCase();
  if (!SLUG_PATTERN.test(normalized) || RESERVED_SLUGS.has(normalized)) return null;
  return normalized;
}
function dangerousString(value: string) {
  const v = value.trim().toLowerCase();
  return /<\s*script|<\s*iframe|on[a-z]+\s*=|javascript:|data:text\/html|vbscript:/.test(v);
}
function scan(value: unknown): string | null {
  if (typeof value === "string") return dangerousString(value) ? "Unsafe script, handler, embed, or URL content is not allowed" : null;
  if (Array.isArray(value)) { for (const entry of value) { const err = scan(entry); if (err) return err; } }
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/^on[A-Z]/.test(key) || key === "dangerouslySetInnerHTML" || key === "html" || key === "rawHtml") return "Raw HTML and inline handlers are not allowed";
      const err = scan(entry); if (err) return err;
    }
  }
  return null;
}
function validateNodes(nodes: unknown, path: string): string | null {
  if (!Array.isArray(nodes)) return `${path} must be an array`;
  if (nodes.length > 120) return `${path} may contain at most 120 components`;
  for (const [index, node] of nodes.entries()) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return `${path}[${index}] must be an object`;
    const rec = node as Record<string, unknown>;
    if (typeof rec.type !== "string" || !ALLOWED_COMPONENTS.has(rec.type)) return `${path}[${index}] uses an unapproved component type`;
    const err = scan(rec.props ?? {}); if (err) return err;
  }
  return null;
}
function validatePuckData(data: unknown): string | null {
  const parsed = dataSchema.safeParse(data);
  if (!parsed.success) return parsed.error.message;
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_LAYOUT_BYTES) return `Layout data exceeds ${MAX_LAYOUT_BYTES} bytes`;
  const rec = data as Record<string, unknown>;
  const contentError = validateNodes(rec.content, "content"); if (contentError) return contentError;
  if (rec.zones) for (const [zoneName, zoneContent] of Object.entries(rec.zones as Record<string, unknown>)) { const err = validateNodes(zoneContent, `zones.${zoneName}`); if (err) return err; }
  return scan(data);
}
async function actorTenantId(req: Request): Promise<number> { return req.dbUser?.tenantId ?? await getHouseTenantId(); }
function visibleToTenant(req: Request, tenantId: number) { return normalizeRole(req.dbUser?.role) === "global_admin" || req.dbUser?.tenantId === tenantId; }
function mapPage(page: typeof visualEditorPagesTable.$inferSelect, includeDraft = true) { return { id: page.id, tenantId: page.tenantId, companyId: page.companyId, slug: page.slug, title: page.title, status: page.status, ...(includeDraft ? { draftJson: page.draftJson ?? emptyPuckData } : {}), publishedJson: page.publishedJson, createdAt: page.createdAt, updatedAt: page.updatedAt, publishedAt: page.publishedAt, archivedAt: page.archivedAt }; }
async function audit(req: Request, action: string, page: { tenantId: number; id?: number; slug?: string }) { if (!req.dbUser) return; void writeAuditLog({ actorId: req.dbUser.id, actorEmail: req.dbUser.email, actorRole: req.dbUser.role, action, tenantId: page.tenantId, resourceType: "visual_editor_page", resourceId: String(page.id ?? page.slug ?? "unknown"), ipAddress: req.ip }); }

router.get("/public/pages/:slug", async (req: Request, res: Response): Promise<void> => {
  await ensureVisualEditorSchema();
  const rawSlug = req.params.slug;
  const slug = validateSlug(Array.isArray(rawSlug) ? rawSlug[0] ?? "" : rawSlug ?? "");
  if (!slug) { res.status(404).json({ error: "Not found" }); return; }
  const tenantId = await getHouseTenantId();
  const [page] = await db.select().from(visualEditorPagesTable).where(and(eq(visualEditorPagesTable.tenantId, tenantId), eq(visualEditorPagesTable.slug, slug))).limit(1);
  if (!page || page.archivedAt || !page.publishedJson || page.status === "archived") { res.status(404).json({ error: "Not found" }); return; }
  res.json({ id: page.id, slug: page.slug, title: page.title, publishedJson: page.publishedJson, publishedAt: page.publishedAt });
});

router.use("/admin/visual-editor", requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole("global_admin", "admin", "tenant_admin"));

router.get("/admin/visual-editor/pages", async (req: Request, res: Response): Promise<void> => {
  await ensureVisualEditorSchema();
  const tenantId = await actorTenantId(req);
  const rows = await db.select().from(visualEditorPagesTable).where(eq(visualEditorPagesTable.tenantId, tenantId)).orderBy(desc(visualEditorPagesTable.updatedAt));
  res.json({ pages: rows.map((p: typeof visualEditorPagesTable.$inferSelect) => mapPage(p, false)) });
});

router.post("/admin/visual-editor/pages", async (req: Request, res: Response): Promise<void> => {
  await ensureVisualEditorSchema();
  const body = createPageSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const slug = validateSlug(body.data.slug);
  if (!slug) { res.status(400).json({ error: "Invalid or reserved slug" }); return; }
  const draftJson = body.data.draftJson ?? emptyPuckData;
  const err = validatePuckData(draftJson);
  if (err) { res.status(400).json({ error: err }); return; }
  const tenantId = await actorTenantId(req);
  const [created] = await db.insert(visualEditorPagesTable).values({ tenantId, companyId: tenantId, slug, title: body.data.title, draftJson, createdByUserId: req.dbUser?.id, updatedByUserId: req.dbUser?.id }).returning();
  await audit(req, "visual_editor.page_created", created);
  res.status(201).json(mapPage(created));
});

router.get("/admin/visual-editor/pages/:id", async (req: Request, res: Response): Promise<void> => {
  await ensureVisualEditorSchema();
  const id = Number(req.params.id);
  const [page] = await db.select().from(visualEditorPagesTable).where(eq(visualEditorPagesTable.id, id)).limit(1);
  if (!page || !visibleToTenant(req, page.tenantId)) { res.status(404).json({ error: "Not found" }); return; }
  res.json(mapPage(page));
});

router.patch("/admin/visual-editor/pages/:id/draft", async (req: Request, res: Response): Promise<void> => {
  await ensureVisualEditorSchema();
  const id = Number(req.params.id);
  const body = draftSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const err = validatePuckData(body.data.draftJson);
  if (err) { res.status(400).json({ error: err }); return; }
  const [page] = await db.select().from(visualEditorPagesTable).where(eq(visualEditorPagesTable.id, id)).limit(1);
  if (!page || !visibleToTenant(req, page.tenantId)) { res.status(404).json({ error: "Not found" }); return; }
  const [updated] = await db.update(visualEditorPagesTable).set({ draftJson: body.data.draftJson, status: "draft", updatedByUserId: req.dbUser?.id, updatedAt: new Date() }).where(eq(visualEditorPagesTable.id, id)).returning();
  await audit(req, "visual_editor.draft_saved", page);
  res.json(mapPage(updated ?? page));
});

router.post("/admin/visual-editor/pages/:id/publish", async (req: Request, res: Response): Promise<void> => {
  await ensureVisualEditorSchema();
  const id = Number(req.params.id);
  const [page] = await db.select().from(visualEditorPagesTable).where(eq(visualEditorPagesTable.id, id)).limit(1);
  if (!page || !visibleToTenant(req, page.tenantId)) { res.status(404).json({ error: "Not found" }); return; }
  const err = validatePuckData(page.draftJson);
  if (err) { res.status(400).json({ error: err }); return; }
  const now = new Date();
  await db.insert(visualEditorPageVersionsTable).values({ pageId: page.id, tenantId: page.tenantId, companyId: page.companyId, versionJson: page.draftJson, title: page.title, slug: page.slug, createdByUserId: req.dbUser?.id });
  const [updated] = await db.update(visualEditorPagesTable).set({ publishedJson: page.draftJson, status: "published", updatedByUserId: req.dbUser?.id, publishedByUserId: req.dbUser?.id, updatedAt: now, publishedAt: now }).where(eq(visualEditorPagesTable.id, id)).returning();
  await audit(req, "visual_editor.page_published", page);
  res.json(mapPage(updated ?? page));
});

router.get("/admin/visual-editor/pages/:id/versions", async (req: Request, res: Response): Promise<void> => {
  await ensureVisualEditorSchema();
  const id = Number(req.params.id);
  const [page] = await db.select().from(visualEditorPagesTable).where(eq(visualEditorPagesTable.id, id)).limit(1);
  if (!page || !visibleToTenant(req, page.tenantId)) { res.status(404).json({ error: "Not found" }); return; }
  const versions = await db.select().from(visualEditorPageVersionsTable).where(eq(visualEditorPageVersionsTable.pageId, id)).orderBy(desc(visualEditorPageVersionsTable.createdAt));
  res.json({ versions });
});

router.post("/admin/visual-editor/pages/:id/restore-version", async (req: Request, res: Response): Promise<void> => {
  await ensureVisualEditorSchema();
  const id = Number(req.params.id);
  const body = restoreSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const [page] = await db.select().from(visualEditorPagesTable).where(eq(visualEditorPagesTable.id, id)).limit(1);
  if (!page || !visibleToTenant(req, page.tenantId)) { res.status(404).json({ error: "Not found" }); return; }
  const [version] = await db.select().from(visualEditorPageVersionsTable).where(and(eq(visualEditorPageVersionsTable.pageId, id), eq(visualEditorPageVersionsTable.id, body.data.versionId))).limit(1);
  if (!version) { res.status(404).json({ error: "Version not found" }); return; }
  const [updated] = await db.update(visualEditorPagesTable).set({ draftJson: version.versionJson, status: "draft", updatedByUserId: req.dbUser?.id, updatedAt: new Date() }).where(eq(visualEditorPagesTable.id, id)).returning();
  await audit(req, "visual_editor.version_restored", page);
  res.json(mapPage(updated ?? page));
});

router.post("/admin/visual-editor/pages/:id/archive", async (req: Request, res: Response): Promise<void> => {
  await ensureVisualEditorSchema();
  const id = Number(req.params.id);
  const [page] = await db.select().from(visualEditorPagesTable).where(eq(visualEditorPagesTable.id, id)).limit(1);
  if (!page || !visibleToTenant(req, page.tenantId)) { res.status(404).json({ error: "Not found" }); return; }
  const [updated] = await db.update(visualEditorPagesTable).set({ status: "archived", archivedAt: new Date(), updatedByUserId: req.dbUser?.id, updatedAt: new Date() }).where(eq(visualEditorPagesTable.id, id)).returning();
  await audit(req, "visual_editor.page_archived", page);
  res.json(mapPage(updated ?? page));
});

export default router;
