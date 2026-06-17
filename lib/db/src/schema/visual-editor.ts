import { pgTable, serial, integer, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const visualEditorPagesTable = pgTable(
  "visual_editor_pages",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
    companyId: integer("company_id").references(() => tenantsTable.id),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    draftJson: jsonb("draft_json").notNull().default({ root: { props: {} }, content: [] }),
    publishedJson: jsonb("published_json"),
    status: text("status").notNull().default("draft"),
    createdByUserId: integer("created_by_user_id").references(() => usersTable.id),
    updatedByUserId: integer("updated_by_user_id").references(() => usersTable.id),
    publishedByUserId: integer("published_by_user_id").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    sourceImportPath: text("source_import_path"),
    importedFromPageId: integer("imported_from_page_id"),
  },
  (table) => ({ tenantSlugUnique: uniqueIndex("visual_editor_pages_tenant_slug_unique").on(table.tenantId, table.slug) }),
);

export const visualEditorPageVersionsTable = pgTable("visual_editor_page_versions", {
  id: serial("id").primaryKey(),
  pageId: integer("page_id").notNull().references(() => visualEditorPagesTable.id, { onDelete: "cascade" }),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  companyId: integer("company_id").references(() => tenantsTable.id),
  versionJson: jsonb("version_json").notNull(),
  title: text("title").notNull(),
  slug: text("slug").notNull(),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type VisualEditorPage = typeof visualEditorPagesTable.$inferSelect;
export type InsertVisualEditorPage = typeof visualEditorPagesTable.$inferInsert;
export type VisualEditorPageVersion = typeof visualEditorPageVersionsTable.$inferSelect;
