import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, visualEditorPageVersionsTable, visualEditorPagesTable } from "@workspace/db";
import { importPageToPuck, isSafeInternalPath, sanitizeImportedHtml } from "../lib/puck/importPageToPuck";
import { loadDbUser, normalizeRole, requireApproved, requireAuth, requireDbUser, requireRole, writeAuditLog } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";

const router: IRouter = Router();

const ALLOWED_COMPONENTS = new Set([
  "HeroSection", "TextBlock", "ImageBlock", "CTAButton", "ProductPromoGrid", "FAQBlock", "FeatureGrid",
  "AnnouncementBanner", "ContactInfoBlock", "StoreHoursBlock", "CatalogSection", "FeaturedProductsBlock", "SafeHtmlBlock",
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
const importSourceSchema = z.object({ sourceType: z.enum(["internal_path", "page_id"]), path: z.string().trim().max(300).optional(), pageId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)]).optional() }).strict();
const importPageSchema = importSourceSchema.extend({ title: z.string().trim().min(1).max(140), slug: z.string().trim().toLowerCase() }).strict();

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
    sql`ALTER TABLE "visual_editor_pages" ADD COLUMN IF NOT EXISTS "source_import_path" text`,
    sql`ALTER TABLE "visual_editor_pages" ADD COLUMN IF NOT EXISTS "imported_from_page_id" integer`,
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

function htmlFromPuckData(data: unknown): string {
  const rec = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const nodes = Array.isArray(rec.content) ? rec.content : [];
  return nodes.map((node) => {
    const block = node && typeof node === "object" ? node as { type?: unknown; props?: Record<string, unknown> } : {};
    const props = block.props ?? {};
    if (block.type === "HeroSection") return `<section><h1>${props.title ?? ""}</h1><p>${props.body ?? ""}</p><a href="${props.ctaHref ?? "#"}">${props.ctaLabel ?? ""}</a></section>`;
    if (block.type === "TextBlock") return `<p>${props.text ?? ""}</p>`;
    if (block.type === "ImageBlock") return `<img src="${props.src ?? ""}" alt="${props.alt ?? ""}">`;
    if (block.type === "CTAButton") return `<a href="${props.href ?? "#"}">${props.label ?? ""}</a>`;
    if (block.type === "SafeHtmlBlock") return String(props.sanitizedHtml ?? "");
    return `<div>${Object.values(props).filter((v) => typeof v === "string").join(" ")}</div>`;
  }).join("\n");
}
function slugFromPath(path: string): string | null { if (!isSafeInternalPath(path)) return null; const slug = path.replace(/^\/+/, "").split(/[?#]/)[0]?.replace(/\/$/, "") || "home"; return validateSlug(slug); }
async function loadImportSource(req: Request, input: z.infer<typeof importSourceSchema>) {
  const tenantId = await actorTenantId(req);
  if (input.sourceType === "page_id") {
    if (!input.pageId) throw Object.assign(new Error("pageId is required"), { status: 400 });
    const [page] = await db.select().from(visualEditorPagesTable).where(and(eq(visualEditorPagesTable.id, input.pageId), eq(visualEditorPagesTable.tenantId, tenantId))).limit(1);
    if (!page || page.archivedAt) throw Object.assign(new Error("Import source not found"), { status: 404 });
    return { page, tenantId, path: `/${page.slug}`, html: htmlFromPuckData(page.publishedJson ?? page.draftJson), title: page.title };
  }
  if (!input.path || !isSafeInternalPath(input.path)) throw Object.assign(new Error("Only same-origin internal paths are allowed"), { status: 400 });
  const slug = slugFromPath(input.path);
  if (!slug) throw Object.assign(new Error("Invalid internal path"), { status: 400 });
  const [page] = await db.select().from(visualEditorPagesTable).where(and(eq(visualEditorPagesTable.slug, slug), eq(visualEditorPagesTable.tenantId, tenantId))).limit(1);
  if (!page || page.archivedAt) throw Object.assign(new Error("Import source not found"), { status: 404 });
  return { page, tenantId, path: input.path, html: htmlFromPuckData(page.publishedJson ?? page.draftJson), title: page.title };
}
async function importAudit(req: Request, action: string, tenantId: number, metadata: Record<string, unknown>, id?: number) { if (!req.dbUser) return; await writeAuditLog({ actorId: req.dbUser.id, actorEmail: req.dbUser.email, actorRole: req.dbUser.role, action, tenantId, resourceType: "visual_editor_page", resourceId: id ? String(id) : "import", metadata, ipAddress: req.ip }); }

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


async function requirePagesManage(req: Request, res: Response, next: import("express").NextFunction): Promise<void> {
  const { hasPermission } = await import("../lib/auth");
  if (!(await hasPermission(req.dbUser, "pages.manage", req.dbUser?.tenantId))) { res.status(403).json({ error: "Forbidden: missing permission", permission: "pages.manage" }); return; }
  next();
}
router.use("/admin/pages", requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole("global_admin", "admin", "tenant_admin"), requirePagesManage);

router.get("/admin/pages/importable", async (req: Request, res: Response): Promise<void> => {
  await ensureVisualEditorSchema();
  const tenantId = await actorTenantId(req);
  const rows = await db.select().from(visualEditorPagesTable).where(eq(visualEditorPagesTable.tenantId, tenantId)).orderBy(desc(visualEditorPagesTable.updatedAt));
  res.json({ pages: rows.filter((p) => !p.archivedAt).map((p) => ({ id: p.id, title: p.title, slug: p.slug, path: `/${p.slug}`, status: p.status, updatedAt: p.updatedAt })) });
});

router.post("/admin/pages/import/preview", async (req: Request, res: Response): Promise<void> => {
  await ensureVisualEditorSchema();
  const parsed = importSourceSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const source = await loadImportSource(req, parsed.data);
    await importAudit(req, "visual_editor.import_started", source.tenantId, { sourceType: parsed.data.sourceType, path: source.path, sourcePageId: source.page.id });
    const sanitizedHtml = sanitizeImportedHtml(source.html);
    const puckData = importPageToPuck(sanitizedHtml, source.title);
    res.json({ source: { pageId: source.page.id, path: source.path, title: source.title }, sanitizedHtml, puckData });
  } catch (err) {
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    await importAudit(req, "visual_editor.import_failed", await actorTenantId(req), { reason: err instanceof Error ? err.message : "Unknown error" });
    res.status(status).json({ error: err instanceof Error ? err.message : "Import failed" });
  }
});

router.post("/admin/pages/import", async (req: Request, res: Response): Promise<void> => {
  await ensureVisualEditorSchema();
  const parsed = importPageSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const slug = validateSlug(parsed.data.slug);
  if (!slug) { res.status(400).json({ error: "Invalid or reserved slug" }); return; }
  try {
    const source = await loadImportSource(req, parsed.data);
    await importAudit(req, "visual_editor.import_started", source.tenantId, { sourceType: parsed.data.sourceType, path: source.path, sourcePageId: source.page.id });
    const draftJson = importPageToPuck(source.html, parsed.data.title);
    const err = validatePuckData(draftJson);
    if (err) throw Object.assign(new Error(err), { status: 400 });
    const [created] = await db.insert(visualEditorPagesTable).values({ tenantId: source.tenantId, companyId: source.tenantId, slug, title: parsed.data.title, draftJson, status: "draft", sourceImportPath: source.path, importedFromPageId: source.page.id, createdByUserId: req.dbUser?.id, updatedByUserId: req.dbUser?.id }).returning();
    await db.insert(visualEditorPageVersionsTable).values({ pageId: created.id, tenantId: source.tenantId, companyId: source.tenantId, versionJson: draftJson, title: created.title, slug: created.slug, createdByUserId: req.dbUser?.id });
    await importAudit(req, "visual_editor.import_saved_as_draft", source.tenantId, { sourcePath: source.path, sourcePageId: source.page.id, draftPageId: created.id }, created.id);
    res.status(201).json(mapPage(created));
  } catch (err) {
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    await importAudit(req, "visual_editor.import_failed", await actorTenantId(req), { reason: err instanceof Error ? err.message : "Unknown error" });
    res.status(status).json({ error: err instanceof Error ? err.message : "Import failed" });
  }
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
  if (page.sourceImportPath || page.importedFromPageId) await importAudit(req, "visual_editor.imported_page_published", page.tenantId, { pageId: page.id, sourceImportPath: page.sourceImportPath ?? null, importedFromPageId: page.importedFromPageId ?? null }, page.id);
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
