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

export const visualEditorPagesTable = pgTable(
  "visual_editor_pages",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
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
    tenantSlugUnique: uniqueIndex("visual_editor_pages_tenant_slug_unique").on(table.tenantId, table.slug),
  }),
);

export type VisualEditorPage = typeof visualEditorPagesTable.$inferSelect;
export type InsertVisualEditorPage = typeof visualEditorPagesTable.$inferInsert;
