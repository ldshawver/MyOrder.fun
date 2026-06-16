import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { and, desc, eq, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";
import { db, visualEditorPagesTable, visualEditorPageVersionsTable } from "@workspace/db";
import { loadDbUser, requireApproved, requireAuth, requireDbUser, requireRole, writeAuditLog } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";

const router: IRouter = Router();
const adminRouter: IRouter = Router();
const savePublishLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
const RESERVED_SLUGS = new Set(["admin", "api", "app", "checkout", "cart", "login", "logout", "orders", "settings", "inventory", "shifts", "payments"]);
const COMPONENT_PROP_ALLOWLIST: Record<string, readonly string[]> = {
  HeroSection: ["eyebrow", "title", "body", "ctaLabel", "ctaHref", "align", "tone"],
  TextBlock: ["text", "align"],
  ImageBlock: ["imageUrl", "alt", "caption"],
  CTAButton: ["label", "href", "variant"],
  ProductPromoGrid: ["title", "products", "layout"],
  FAQBlock: ["title", "questions"],
  FeatureGrid: ["title", "features"],
  AnnouncementBanner: ["text", "tone"],
  ContactInfoBlock: ["title", "phone", "email", "address"],
  StoreHoursBlock: ["title", "hours"],
  CatalogPresentationBlock: ["title", "displayName", "description", "imageUrl", "categoryDisplay", "badges", "featured", "sortOrder", "quantityLabel", "priceDisplayFormat", "availabilityText", "layoutStyle", "visible"],
};
const ALLOWED_COMPONENTS = new Set(Object.keys(COMPONENT_PROP_ALLOWLIST));
const BLOCKED_CATALOG_KEYS = new Set(["inventoryCount", "inventoryQuantity", "inventoryLocationId", "stock", "stockReservation", "checkoutQuantity", "serverPrice", "price", "tax", "shipping", "discount", "paymentState", "orderState", "tenantId", "ownerId", "productOwnerId", "role", "permission"]);
const MAX_LAYOUT_BYTES = 250_000;
const emptyPuckData = { root: { props: {} }, content: [] };
let schemaEnsured = false;

async function ensureVisualEditorSchema(): Promise<void> {
  if (schemaEnsured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "visual_editor_pages" (
    "id" serial PRIMARY KEY NOT NULL,
    "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
    "slug" text NOT NULL,
    "title" text NOT NULL,
    "status" text NOT NULL DEFAULT 'draft',
    "draft_json" jsonb NOT NULL DEFAULT '{"root":{"props":{}},"content":[]}'::jsonb,
    "published_json" jsonb,
    "created_by_user_id" integer NOT NULL REFERENCES "users"("id"),
    "updated_by_user_id" integer REFERENCES "users"("id"),
    "published_by_user_id" integer REFERENCES "users"("id"),
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "published_at" timestamp with time zone,
    "archived_at" timestamp with time zone
  )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "visual_editor_pages_tenant_slug_unique" ON "visual_editor_pages" ("tenant_id", "slug")`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "visual_editor_page_versions" (
    "id" serial PRIMARY KEY NOT NULL,
    "page_id" integer NOT NULL REFERENCES "visual_editor_pages"("id"),
    "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
    "version_number" integer NOT NULL,
    "content_json" jsonb NOT NULL,
    "created_by_user_id" integer NOT NULL REFERENCES "users"("id"),
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "note" text
  )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "visual_editor_page_versions_page_number_unique" ON "visual_editor_page_versions" ("page_id", "version_number")`);
  schemaEnsured = true;
}

const slugSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,80}$/).refine((slug) => !RESERVED_SLUGS.has(slug), "Reserved slug");
const createPageSchema = z.object({ slug: slugSchema, title: z.string().trim().min(1).max(120) }).strict();
const draftSchema = z.object({ data: z.unknown() }).strict();
const restoreSchema = z.object({ versionId: z.number().int().positive(), note: z.string().max(200).optional() }).strict();

function safeUrl(value: unknown): boolean {
  if (value == null || value === "" || value === "#") return true;
  if (typeof value !== "string" || /[<>"'`]/.test(value) || [...value].some((char) => char.charCodeAt(0) < 32)) return false;
  if (value.startsWith("/")) return !value.startsWith("//") && !value.includes("..");
  try { const url = new URL(value); return ["https:", "mailto:", "tel:"].includes(url.protocol); } catch { return false; }
}
function validateText(value: unknown): boolean { return typeof value !== "string" || (!/<\/?(?:script|iframe|object|embed|style|link|meta|html|body)\b/i.test(value) && !/on\w+\s*=|javascript:/i.test(value)); }
function byteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function validateNode(node: unknown): string | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return "Component must be an object";
  const record = node as Record<string, unknown>;
  if (typeof record.type !== "string" || !ALLOWED_COMPONENTS.has(record.type)) return "Unapproved component type";
  const props = record.props;
  if (props !== undefined) {
    if (!props || typeof props !== "object" || Array.isArray(props)) return "Component props must be an object";
    const allowedProps = COMPONENT_PROP_ALLOWLIST[record.type];
    if (!allowedProps) return "Unapproved component type";
    for (const [key, value] of Object.entries(props)) {
      if (!allowedProps.includes(key)) return `Unapproved prop ${key} for ${record.type}`;
      if (BLOCKED_CATALOG_KEYS.has(key)) return "Restricted catalog/business field rejected";
      if (["href", "url", "imageUrl", "src", "link", "ctaHref"].includes(key) && !safeUrl(value)) return "Unsafe URL rejected";
      if (!validateText(value)) return "HTML/script content rejected";
    }
  }
  return null;
}
function validatePuckData(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "Layout data must be an object";
  if (byteLength(data) > MAX_LAYOUT_BYTES) return `Layout data exceeds ${MAX_LAYOUT_BYTES} bytes`;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.content)) return "content must be an array";
  for (const node of record.content) { const err = validateNode(node); if (err) return err; }
  if (record.zones !== undefined) {
    if (!record.zones || typeof record.zones !== "object" || Array.isArray(record.zones)) return "zones must be an object";
    for (const zone of Object.values(record.zones)) {
      if (!Array.isArray(zone)) return "zone content must be an array";
      for (const node of zone) { const err = validateNode(node); if (err) return err; }
    }
  }
  return null;
}
async function actorTenantId() { return getHouseTenantId(); }
function mapPage(page: typeof visualEditorPagesTable.$inferSelect, includeDraft = true) { return { id: page.id, slug: page.slug, title: page.title, status: page.status, ...(includeDraft ? { draftData: page.draftData ?? emptyPuckData } : {}), publishedData: page.publishedData, updatedAt: page.updatedAt, publishedAt: page.publishedAt }; }
async function findPage(id: number, tenantId: number) { const [page] = await db.select().from(visualEditorPagesTable).where(and(eq(visualEditorPagesTable.id, id), eq(visualEditorPagesTable.tenantId, tenantId), isNull(visualEditorPagesTable.archivedAt))).limit(1); return page; }
async function audit(entry: { actorId: number; actorEmail: string | null; actorRole: string; action: string; tenantId: number; resourceType: string; resourceId: string; ipAddress?: string }) { void writeAuditLog(entry); }

adminRouter.use(requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole("global_admin", "admin"));

adminRouter.get("/admin/visual-editor/pages", async (_req, res) => { await ensureVisualEditorSchema(); const tenantId = await actorTenantId(); const pages = await db.select().from(visualEditorPagesTable).where(and(eq(visualEditorPagesTable.tenantId, tenantId), isNull(visualEditorPagesTable.archivedAt))).orderBy(desc(visualEditorPagesTable.updatedAt)); res.json({ pages: pages.map((p) => mapPage(p, false)) }); });
adminRouter.post("/admin/visual-editor/pages", async (req, res) => { await ensureVisualEditorSchema(); const parsed = createPageSchema.safeParse(req.body); if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid page" }); const tenantId = await actorTenantId(); const [created] = await db.insert(visualEditorPagesTable).values({ tenantId, slug: parsed.data.slug, title: parsed.data.title, draftData: emptyPuckData, createdById: req.dbUser!.id, updatedById: req.dbUser!.id }).returning(); await audit({ actorId: req.dbUser!.id, actorEmail: req.dbUser!.email, actorRole: req.dbUser!.role, action: "visual_editor.created", tenantId, resourceType: "visual_editor_page", resourceId: created.slug, ipAddress: req.ip }); res.status(201).json(mapPage(created)); });
adminRouter.get("/admin/visual-editor/pages/:id", async (req, res) => { await ensureVisualEditorSchema(); const page = await findPage(Number(req.params.id), await actorTenantId()); if (!page) return void res.status(404).json({ error: "Page not found" }); res.json(mapPage(page)); });
adminRouter.patch("/admin/visual-editor/pages/:id/draft", savePublishLimiter, async (req, res) => { await ensureVisualEditorSchema(); const parsed = draftSchema.safeParse(req.body); if (!parsed.success) return void res.status(400).json({ error: "Unknown or invalid fields" }); const validationError = validatePuckData(parsed.data.data); if (validationError) return void res.status(400).json({ error: validationError }); const page = await findPage(Number(req.params.id), await actorTenantId()); if (!page) return void res.status(404).json({ error: "Page not found" }); const [updated] = await db.update(visualEditorPagesTable).set({ draftData: parsed.data.data, status: "draft", updatedById: req.dbUser!.id, updatedAt: new Date() }).where(eq(visualEditorPagesTable.id, page.id)).returning(); await audit({ actorId: req.dbUser!.id, actorEmail: req.dbUser!.email, actorRole: req.dbUser!.role, action: "visual_editor.draft_saved", tenantId: page.tenantId, resourceType: "visual_editor_page", resourceId: page.slug, ipAddress: req.ip }); res.json(mapPage(updated)); });
adminRouter.post("/admin/visual-editor/pages/:id/publish", savePublishLimiter, async (req, res) => { await ensureVisualEditorSchema(); const page = await findPage(Number(req.params.id), await actorTenantId()); if (!page) return void res.status(404).json({ error: "Page not found" }); const validationError = validatePuckData(page.draftData); if (validationError) return void res.status(400).json({ error: validationError }); const [{ value }] = await db.select({ value: max(visualEditorPageVersionsTable.versionNumber) }).from(visualEditorPageVersionsTable).where(eq(visualEditorPageVersionsTable.pageId, page.id)); const versionNumber = (value ?? 0) + 1; await db.insert(visualEditorPageVersionsTable).values({ pageId: page.id, tenantId: page.tenantId, versionNumber, contentJson: page.draftData, createdById: req.dbUser!.id, note: "Published" }); const now = new Date(); const [updated] = await db.update(visualEditorPagesTable).set({ publishedData: page.draftData, status: "published", updatedById: req.dbUser!.id, publishedById: req.dbUser!.id, updatedAt: now, publishedAt: now }).where(eq(visualEditorPagesTable.id, page.id)).returning(); await audit({ actorId: req.dbUser!.id, actorEmail: req.dbUser!.email, actorRole: req.dbUser!.role, action: "visual_editor.published", tenantId: page.tenantId, resourceType: "visual_editor_page", resourceId: page.slug, ipAddress: req.ip }); res.json({ ...mapPage(updated), versionNumber }); });
adminRouter.get("/admin/visual-editor/pages/:id/versions", async (req, res) => { await ensureVisualEditorSchema(); const page = await findPage(Number(req.params.id), await actorTenantId()); if (!page) return void res.status(404).json({ error: "Page not found" }); const versions = await db.select().from(visualEditorPageVersionsTable).where(eq(visualEditorPageVersionsTable.pageId, page.id)).orderBy(desc(visualEditorPageVersionsTable.versionNumber)); res.json({ versions }); });
adminRouter.post("/admin/visual-editor/pages/:id/restore-version", savePublishLimiter, async (req, res) => { await ensureVisualEditorSchema(); const parsed = restoreSchema.safeParse(req.body); if (!parsed.success) return void res.status(400).json({ error: "Invalid restore request" }); const page = await findPage(Number(req.params.id), await actorTenantId()); if (!page) return void res.status(404).json({ error: "Page not found" }); const [version] = await db.select().from(visualEditorPageVersionsTable).where(and(eq(visualEditorPageVersionsTable.id, parsed.data.versionId), eq(visualEditorPageVersionsTable.pageId, page.id))).limit(1); if (!version) return void res.status(404).json({ error: "Version not found" }); const [updated] = await db.update(visualEditorPagesTable).set({ draftData: version.contentJson, status: "draft", updatedById: req.dbUser!.id, updatedAt: new Date() }).where(eq(visualEditorPagesTable.id, page.id)).returning(); await audit({ actorId: req.dbUser!.id, actorEmail: req.dbUser!.email, actorRole: req.dbUser!.role, action: "visual_editor.version_restored", tenantId: page.tenantId, resourceType: "visual_editor_page", resourceId: page.slug, ipAddress: req.ip }); res.json(mapPage(updated)); });

router.use(adminRouter);
router.get("/public/pages/:slug", async (req, res) => { await ensureVisualEditorSchema(); const slug = slugSchema.safeParse(req.params.slug); if (!slug.success) return void res.status(404).json({ error: "Page not found" }); const tenantId = await actorTenantId(); const [page] = await db.select().from(visualEditorPagesTable).where(and(eq(visualEditorPagesTable.tenantId, tenantId), eq(visualEditorPagesTable.slug, slug.data), eq(visualEditorPagesTable.status, "published"), isNull(visualEditorPagesTable.archivedAt))).limit(1); if (!page?.publishedData) return void res.status(404).json({ error: "Page not found" }); res.json({ id: page.id, slug: page.slug, title: page.title, publishedData: page.publishedData, publishedAt: page.publishedAt }); });

export default router;
