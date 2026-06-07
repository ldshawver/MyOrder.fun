import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, webPagesTable, webPageVersionsTable } from "@workspace/db";
import {
  requireAuth,
  loadDbUser,
  requireDbUser,
  requireApproved,
  requireRole,
  writeAuditLog,
} from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";

const router: IRouter = Router();

const ALLOWED_COMPONENTS = new Set([
  "Hero",
  "TextBlock",
  "ImageBanner",
  "PromoBanner",
  "CTA",
  "FAQ",
]);

const MAX_DATA_BYTES = 500_000;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;
const TITLE_MAX = 120;
const MAX_VERSIONS_PER_PAGE = 50;

const emptyPuckData = { root: { props: {} }, content: [] };

let schemaEnsured = false;

async function ensureWebEditorSchema(): Promise<void> {
  if (schemaEnsured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "web_pages" (
      "id" serial PRIMARY KEY NOT NULL,
      "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
      "slug" text NOT NULL,
      "title" text NOT NULL,
      "description" text,
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
    CREATE UNIQUE INDEX IF NOT EXISTS "web_pages_tenant_slug_unique"
      ON "web_pages" ("tenant_id", "slug")
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "web_page_versions" (
      "id" serial PRIMARY KEY NOT NULL,
      "page_id" integer NOT NULL REFERENCES "web_pages"("id"),
      "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
      "version_number" integer NOT NULL DEFAULT 1,
      "data" jsonb NOT NULL,
      "label" text,
      "created_by_id" integer REFERENCES "users"("id"),
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `);
  schemaEnsured = true;
}

function validateSlug(raw: string): string | null {
  const s = (Array.isArray(raw) ? raw[0] : raw ?? "").trim().toLowerCase();
  return SLUG_PATTERN.test(s) ? s : null;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function validateContentNodes(nodes: unknown, path: string): string | null {
  if (!Array.isArray(nodes)) return `${path} must be an array`;
  if (nodes.length > 100) return `${path} may contain at most 100 components`;
  for (const [i, node] of nodes.entries()) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return `${path}[${i}] must be an object`;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.type !== "string" || !ALLOWED_COMPONENTS.has(record.type)) {
      return `${path}[${i}] uses an unapproved component type "${String(record.type)}"`;
    }
    if (
      record.props !== undefined &&
      (typeof record.props !== "object" || record.props === null || Array.isArray(record.props))
    ) {
      return `${path}[${i}].props must be an object`;
    }
  }
  return null;
}

function validatePuckData(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Page data must be a JSON object";
  }
  if (byteLength(data) > MAX_DATA_BYTES) {
    return `Page data exceeds ${MAX_DATA_BYTES} bytes`;
  }
  const record = data as Record<string, unknown>;
  const contentErr = validateContentNodes(record.content, "content");
  if (contentErr) return contentErr;
  return null;
}

function mapPage(page: typeof webPagesTable.$inferSelect) {
  return {
    id: page.id,
    slug: page.slug,
    title: page.title,
    description: page.description ?? null,
    status: page.status,
    draftData: page.draftData ?? emptyPuckData,
    publishedData: page.publishedData ?? null,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    publishedAt: page.publishedAt ?? null,
  };
}

// ─── All admin routes require authentication ──────────────────────────────────
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

// ─── GET /api/web-editor/pages ────────────────────────────────────────────────
router.get(
  "/web-editor/pages",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    await ensureWebEditorSchema();
    const tenantId = await getHouseTenantId();
    const pages = await db
      .select()
      .from(webPagesTable)
      .where(eq(webPagesTable.tenantId, tenantId))
      .orderBy(desc(webPagesTable.updatedAt));
    res.json({ pages: pages.map(mapPage) });
  },
);

// ─── GET /api/web-editor/pages/:slug ─────────────────────────────────────────
router.get(
  "/web-editor/pages/:slug",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const slug = validateSlug(Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug ?? "");
    if (!slug) {
      res.status(400).json({ error: "Invalid page slug" });
      return;
    }
    await ensureWebEditorSchema();
    const tenantId = await getHouseTenantId();
    const [page] = await db
      .select()
      .from(webPagesTable)
      .where(and(eq(webPagesTable.tenantId, tenantId), eq(webPagesTable.slug, slug)))
      .limit(1);
    if (!page) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    const versions = await db
      .select({
        id: webPageVersionsTable.id,
        versionNumber: webPageVersionsTable.versionNumber,
        label: webPageVersionsTable.label,
        createdAt: webPageVersionsTable.createdAt,
      })
      .from(webPageVersionsTable)
      .where(eq(webPageVersionsTable.pageId, page.id))
      .orderBy(desc(webPageVersionsTable.versionNumber))
      .limit(20);
    res.json({ ...mapPage(page), versions });
  },
);

// ─── POST /api/web-editor/pages ───────────────────────────────────────────────
router.post(
  "/web-editor/pages",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const body = req.body as { slug?: unknown; title?: unknown; description?: unknown };
    const slug = validateSlug(String(body.slug ?? ""));
    if (!slug) {
      res.status(400).json({ error: "slug is required and must match [a-z0-9][a-z0-9-]{0,80}" });
      return;
    }
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > TITLE_MAX) {
      res.status(400).json({ error: `title is required (max ${TITLE_MAX} chars)` });
      return;
    }
    const description = typeof body.description === "string" ? body.description.trim() || null : null;
    await ensureWebEditorSchema();
    const tenantId = await getHouseTenantId();
    const [existing] = await db
      .select({ id: webPagesTable.id })
      .from(webPagesTable)
      .where(and(eq(webPagesTable.tenantId, tenantId), eq(webPagesTable.slug, slug)))
      .limit(1);
    if (existing) {
      res.status(409).json({ error: `A page with slug "${slug}" already exists` });
      return;
    }
    const [page] = await db
      .insert(webPagesTable)
      .values({
        tenantId,
        slug,
        title,
        description,
        draftData: emptyPuckData,
        createdById: req.dbUser!.id,
        updatedById: req.dbUser!.id,
      })
      .returning();
    void writeAuditLog({
      actorId: req.dbUser!.id,
      actorEmail: req.dbUser!.email,
      actorRole: req.dbUser!.role,
      action: "web_editor.page_created",
      tenantId,
      resourceType: "web_page",
      resourceId: slug,
      ipAddress: req.ip,
    });
    res.status(201).json(mapPage(page));
  },
);

// ─── PATCH /api/web-editor/pages/:slug ───────────────────────────────────────
router.patch(
  "/web-editor/pages/:slug",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const slug = validateSlug(Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug ?? "");
    if (!slug) {
      res.status(400).json({ error: "Invalid page slug" });
      return;
    }
    const body = req.body as { data?: unknown; title?: unknown; description?: unknown };
    await ensureWebEditorSchema();
    const tenantId = await getHouseTenantId();
    const [page] = await db
      .select()
      .from(webPagesTable)
      .where(and(eq(webPagesTable.tenantId, tenantId), eq(webPagesTable.slug, slug)))
      .limit(1);
    if (!page) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    const patch: Partial<typeof webPagesTable.$inferInsert> = {
      updatedById: req.dbUser!.id,
      updatedAt: new Date(),
    };
    if (body.data !== undefined) {
      const err = validatePuckData(body.data);
      if (err) {
        res.status(400).json({ error: err });
        return;
      }
      patch.draftData = body.data;
    }
    if (typeof body.title === "string") {
      const t = body.title.trim();
      if (!t || t.length > TITLE_MAX) {
        res.status(400).json({ error: `title must be 1–${TITLE_MAX} chars` });
        return;
      }
      patch.title = t;
    }
    if (body.description !== undefined) {
      patch.description = typeof body.description === "string" ? body.description.trim() || null : null;
    }
    const [updated] = await db
      .update(webPagesTable)
      .set(patch)
      .where(eq(webPagesTable.id, page.id))
      .returning();
    void writeAuditLog({
      actorId: req.dbUser!.id,
      actorEmail: req.dbUser!.email,
      actorRole: req.dbUser!.role,
      action: "web_editor.draft_saved",
      tenantId,
      resourceType: "web_page",
      resourceId: slug,
      ipAddress: req.ip,
    });
    res.json(mapPage(updated ?? page));
  },
);

// ─── POST /api/web-editor/pages/:slug/publish ─────────────────────────────────
router.post(
  "/web-editor/pages/:slug/publish",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const slug = validateSlug(Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug ?? "");
    if (!slug) {
      res.status(400).json({ error: "Invalid page slug" });
      return;
    }
    const body = req.body as { label?: unknown };
    const versionLabel = typeof body.label === "string" ? body.label.trim().slice(0, 80) || null : null;
    await ensureWebEditorSchema();
    const tenantId = await getHouseTenantId();
    const [page] = await db
      .select()
      .from(webPagesTable)
      .where(and(eq(webPagesTable.tenantId, tenantId), eq(webPagesTable.slug, slug)))
      .limit(1);
    if (!page) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    const dataErr = validatePuckData(page.draftData);
    if (dataErr) {
      res.status(400).json({ error: `Draft data is invalid: ${dataErr}` });
      return;
    }
    const [latestVersion] = await db
      .select({ versionNumber: webPageVersionsTable.versionNumber })
      .from(webPageVersionsTable)
      .where(eq(webPageVersionsTable.pageId, page.id))
      .orderBy(desc(webPageVersionsTable.versionNumber))
      .limit(1);
    const nextVersion = (latestVersion?.versionNumber ?? 0) + 1;

    const versionCountRow = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(webPageVersionsTable)
      .where(eq(webPageVersionsTable.pageId, page.id));
    const versionCount = versionCountRow[0]?.count ?? 0;

    if (versionCount >= MAX_VERSIONS_PER_PAGE) {
      const oldestRows = await db
        .select({ id: webPageVersionsTable.id })
        .from(webPageVersionsTable)
        .where(eq(webPageVersionsTable.pageId, page.id))
        .orderBy(webPageVersionsTable.versionNumber)
        .limit(versionCount - MAX_VERSIONS_PER_PAGE + 1);
      for (const row of oldestRows) {
        await db.delete(webPageVersionsTable).where(eq(webPageVersionsTable.id, row.id));
      }
    }

    const [version] = await db
      .insert(webPageVersionsTable)
      .values({
        pageId: page.id,
        tenantId,
        versionNumber: nextVersion,
        data: page.draftData,
        label: versionLabel,
        createdById: req.dbUser!.id,
      })
      .returning();

    const now = new Date();
    const [updated] = await db
      .update(webPagesTable)
      .set({
        publishedData: page.draftData,
        status: "published",
        publishedById: req.dbUser!.id,
        updatedById: req.dbUser!.id,
        updatedAt: now,
        publishedAt: now,
      })
      .where(eq(webPagesTable.id, page.id))
      .returning();

    void writeAuditLog({
      actorId: req.dbUser!.id,
      actorEmail: req.dbUser!.email,
      actorRole: req.dbUser!.role,
      action: "web_editor.page_published",
      tenantId,
      resourceType: "web_page",
      resourceId: slug,
      metadata: { versionNumber: nextVersion, versionLabel },
      ipAddress: req.ip,
    });

    res.json({ ...mapPage(updated ?? page), version });
  },
);

// ─── GET /api/web-editor/pages/:slug/versions ─────────────────────────────────
router.get(
  "/web-editor/pages/:slug/versions",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const slug = validateSlug(Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug ?? "");
    if (!slug) {
      res.status(400).json({ error: "Invalid page slug" });
      return;
    }
    await ensureWebEditorSchema();
    const tenantId = await getHouseTenantId();
    const [page] = await db
      .select({ id: webPagesTable.id })
      .from(webPagesTable)
      .where(and(eq(webPagesTable.tenantId, tenantId), eq(webPagesTable.slug, slug)))
      .limit(1);
    if (!page) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    const versions = await db
      .select()
      .from(webPageVersionsTable)
      .where(eq(webPageVersionsTable.pageId, page.id))
      .orderBy(desc(webPageVersionsTable.versionNumber))
      .limit(50);
    res.json({ versions });
  },
);

export default router;
