import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, visualEditorPagesTable } from "@workspace/db";
import { loadDbUser, requireApproved, requireAuth, requireDbUser, requireRole, writeAuditLog } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole("global_admin", "admin"));

const ALLOWED_COMPONENTS = new Set([
  "DashboardCard",
  "CatalogSection",
  "HeroSection",
  "StaffPanel",
  "EditableButton",
  "HeadingBlock",
  "TextBlock",
  "LayoutContainer",
]);
const MAX_LAYOUT_BYTES = 250_000;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;
const DEFAULT_SLUG = "workspace";

const emptyPuckData = { root: { props: {} }, content: [] };
let schemaEnsured = false;

async function ensureVisualEditorSchema(): Promise<void> {
  if (schemaEnsured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "visual_editor_pages" (
      "id" serial PRIMARY KEY NOT NULL,
      "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
      "slug" text NOT NULL,
      "title" text NOT NULL,
      "status" text NOT NULL DEFAULT 'draft',
      "draft_data" jsonb NOT NULL DEFAULT '{"root":{"props":{}},"content":[]}'::jsonb,
      "published_data" jsonb,
      "created_by_id" integer REFERENCES "users"("id"),
      "updated_by_id" integer REFERENCES "users"("id"),
      "published_by_id" integer REFERENCES "users"("id"),
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      "published_at" timestamp with time zone
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "visual_editor_pages_tenant_slug_unique"
      ON "visual_editor_pages" ("tenant_id", "slug")
  `);
  schemaEnsured = true;
}

function validateSlug(slug: string): string | null {
  const normalized = slug.trim().toLowerCase();
  return SLUG_PATTERN.test(normalized) ? normalized : null;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function validateContentNodes(nodes: unknown, path: string): string | null {
  if (!Array.isArray(nodes)) return `${path} must be an array`;
  if (nodes.length > 120) return `${path} may contain at most 120 components`;
  for (const [index, node] of nodes.entries()) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return `${path}[${index}] must be an object`;
    const record = node as Record<string, unknown>;
    if (typeof record.type !== "string" || !ALLOWED_COMPONENTS.has(record.type)) {
      return `${path}[${index}] uses an unapproved component type`;
    }
    if (record.props !== undefined && (typeof record.props !== "object" || record.props === null || Array.isArray(record.props))) {
      return `${path}[${index}].props must be an object`;
    }
  }
  return null;
}

function validatePuckData(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "Layout data must be an object";
  if (byteLength(data) > MAX_LAYOUT_BYTES) return `Layout data exceeds ${MAX_LAYOUT_BYTES} bytes`;
  const record = data as Record<string, unknown>;
  const contentError = validateContentNodes(record.content, "content");
  if (contentError) return contentError;
  if (record.zones !== undefined) {
    if (!record.zones || typeof record.zones !== "object" || Array.isArray(record.zones)) return "zones must be an object";
    for (const [zoneName, zoneContent] of Object.entries(record.zones as Record<string, unknown>)) {
      const zoneError = validateContentNodes(zoneContent, `zones.${zoneName}`);
      if (zoneError) return zoneError;
    }
  }
  return null;
}

async function getOrCreatePage(slug: string, actorId?: number) {
  await ensureVisualEditorSchema();
  const tenantId = await getHouseTenantId();
  const where = and(eq(visualEditorPagesTable.tenantId, tenantId), eq(visualEditorPagesTable.slug, slug));
  const [existing] = await db.select().from(visualEditorPagesTable).where(where).limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(visualEditorPagesTable)
    .values({
      tenantId,
      slug,
      title: slug === DEFAULT_SLUG ? "MyOrder.fun workspace" : slug.replace(/-/g, " "),
      draftData: emptyPuckData,
      createdById: actorId ?? null,
      updatedById: actorId ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [afterConflict] = await db.select().from(visualEditorPagesTable).where(where).limit(1);
  if (!afterConflict) throw new Error("Could not create visual editor page");
  return afterConflict;
}

function mapPage(page: typeof visualEditorPagesTable.$inferSelect) {
  return {
    id: page.id,
    slug: page.slug,
    title: page.title,
    status: page.status,
    draftData: page.draftData ?? emptyPuckData,
    publishedData: page.publishedData,
    updatedAt: page.updatedAt,
    publishedAt: page.publishedAt,
  };
}

router.get("/admin/visual-editor/pages/:slug", async (req, res): Promise<void> => {
  const slug = validateSlug(req.params.slug ?? "");
  if (!slug) {
    res.status(400).json({ error: "Invalid page slug" });
    return;
  }
  const page = await getOrCreatePage(slug, req.dbUser?.id);
  res.json(mapPage(page));
});

router.put("/admin/visual-editor/pages/:slug/draft", async (req, res): Promise<void> => {
  const slug = validateSlug(req.params.slug ?? "");
  if (!slug) {
    res.status(400).json({ error: "Invalid page slug" });
    return;
  }
  const data = (req.body as { data?: unknown } | undefined)?.data;
  const validationError = validatePuckData(data);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }
  const page = await getOrCreatePage(slug, req.dbUser?.id);
  const [updated] = await db
    .update(visualEditorPagesTable)
    .set({ draftData: data, status: "draft", updatedById: req.dbUser?.id, updatedAt: new Date() })
    .where(eq(visualEditorPagesTable.id, page.id))
    .returning();
  if (req.dbUser) {
    void writeAuditLog({
      actorId: req.dbUser.id,
      actorEmail: req.dbUser.email,
      actorRole: req.dbUser.role,
      action: "visual_editor.draft_saved",
      tenantId: page.tenantId,
      resourceType: "visual_editor_page",
      resourceId: page.slug,
      ipAddress: req.ip,
    });
  }
  res.json(mapPage(updated ?? page));
});

router.post("/admin/visual-editor/pages/:slug/publish", async (req, res): Promise<void> => {
  const slug = validateSlug(req.params.slug ?? "");
  if (!slug) {
    res.status(400).json({ error: "Invalid page slug" });
    return;
  }
  const page = await getOrCreatePage(slug, req.dbUser?.id);
  const validationError = validatePuckData(page.draftData);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }
  const now = new Date();
  const [updated] = await db
    .update(visualEditorPagesTable)
    .set({
      publishedData: page.draftData,
      status: "published",
      updatedById: req.dbUser?.id,
      publishedById: req.dbUser?.id,
      updatedAt: now,
      publishedAt: now,
    })
    .where(eq(visualEditorPagesTable.id, page.id))
    .returning();
  if (req.dbUser) {
    void writeAuditLog({
      actorId: req.dbUser.id,
      actorEmail: req.dbUser.email,
      actorRole: req.dbUser.role,
      action: "visual_editor.published",
      tenantId: page.tenantId,
      resourceType: "visual_editor_page",
      resourceId: page.slug,
      ipAddress: req.ip,
    });
  }
  res.json(mapPage(updated ?? page));
});

export default router;
