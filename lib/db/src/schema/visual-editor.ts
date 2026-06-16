import { pgTable, serial, integer, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

const emptyPuckData = { root: { props: {} }, content: [] };

export const visualEditorPagesTable = pgTable(
  "visual_editor_pages",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("draft"),
    draftData: jsonb("draft_json").notNull().default(emptyPuckData),
    publishedData: jsonb("published_json"),
    createdById: integer("created_by_user_id").notNull().references(() => usersTable.id),
    updatedById: integer("updated_by_user_id").references(() => usersTable.id),
    publishedById: integer("published_by_user_id").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    tenantSlugUnique: uniqueIndex("visual_editor_pages_tenant_slug_unique").on(table.tenantId, table.slug),
  }),
);

export const visualEditorPageVersionsTable = pgTable(
  "visual_editor_page_versions",
  {
    id: serial("id").primaryKey(),
    pageId: integer("page_id").notNull().references(() => visualEditorPagesTable.id),
    tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
    versionNumber: integer("version_number").notNull(),
    contentJson: jsonb("content_json").notNull(),
    createdById: integer("created_by_user_id").notNull().references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
  },
  (table) => ({
    pageVersionUnique: uniqueIndex("visual_editor_page_versions_page_number_unique").on(table.pageId, table.versionNumber),
  }),
);

export type VisualEditorPage = typeof visualEditorPagesTable.$inferSelect;
export type InsertVisualEditorPage = typeof visualEditorPagesTable.$inferInsert;
