import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const webPagesTable = pgTable(
  "web_pages",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("draft"),
    draftData: jsonb("draft_data").notNull().default({ root: { props: {} }, content: [] }),
    publishedData: jsonb("published_data"),
    createdById: integer("created_by_id").references(() => usersTable.id),
    updatedById: integer("updated_by_id").references(() => usersTable.id),
    publishedById: integer("published_by_id").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => ({
    tenantSlugUnique: uniqueIndex("web_pages_tenant_slug_unique").on(table.tenantId, table.slug),
  }),
);

export const webPageVersionsTable = pgTable("web_page_versions", {
  id: serial("id").primaryKey(),
  pageId: integer("page_id").notNull().references(() => webPagesTable.id),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  versionNumber: integer("version_number").notNull().default(1),
  data: jsonb("data").notNull(),
  label: text("label"),
  createdById: integer("created_by_id").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WebPage = typeof webPagesTable.$inferSelect;
export type InsertWebPage = typeof webPagesTable.$inferInsert;
export type WebPageVersion = typeof webPageVersionsTable.$inferSelect;
export type InsertWebPageVersion = typeof webPageVersionsTable.$inferInsert;
