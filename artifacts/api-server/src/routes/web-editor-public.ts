import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, webPagesTable } from "@workspace/db";
import { getHouseTenantId } from "../lib/singleTenant";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;

let schemaEnsured = false;

async function ensureWebEditorPublicSchema(): Promise<void> {
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
  schemaEnsured = true;
}

function validateSlug(raw: string | string[]): string | null {
  const s = (Array.isArray(raw) ? raw[0] : raw ?? "").trim().toLowerCase();
  return SLUG_PATTERN.test(s) ? s : null;
}

router.get("/public/pages/:slug", async (req, res): Promise<void> => {
  const slug = validateSlug(req.params.slug ?? "");
  if (!slug) {
    res.status(400).json({ error: "Invalid page slug" });
    return;
  }
  try {
    await ensureWebEditorPublicSchema();
    const tenantId = await getHouseTenantId();
    const [page] = await db
      .select()
      .from(webPagesTable)
      .where(
        and(
          eq(webPagesTable.tenantId, tenantId),
          eq(webPagesTable.slug, slug),
          eq(webPagesTable.status, "published"),
        ),
      )
      .limit(1);
    if (!page || !page.publishedData) {
      res.status(404).json({ error: "Page not found or not published" });
      return;
    }
    res.json({
      slug: page.slug,
      title: page.title,
      description: page.description ?? null,
      publishedData: page.publishedData,
      publishedAt: page.publishedAt ?? null,
    });
  } catch (err) {
    logger.error({ err, slug }, "web-editor public fetch error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
