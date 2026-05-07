import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { tenantsTable } from "./tenants";

/**
 * Feedback & Bug Reporting module.
 *
 * - `type` is the user-facing category they pick when submitting:
 *     "bug" | "ux" | "feature" | "general"
 * - `severity` is the user's own subjective rating at submit time:
 *     "low" | "medium" | "high" | "critical"
 * - `status` is the admin's workflow state:
 *     "new" | "reviewed" | "priority_fix" | "in_progress"
 *     | "waiting_on_user" | "closed" | "rejected"
 * - `priority` is a separate boolean flag so admins can mark anything as
 *   a "Priority Fix" without overwriting the workflow status.
 * - `screenshotData` stores an optional base64-encoded image inline (cap
 *   ~2MB at the API). Object storage was deliberately skipped for the
 *   "simplest working version" pass.
 */
export const feedbackTicketsTable = pgTable("feedback_tickets", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").references(() => tenantsTable.id),
  submitterId: integer("submitter_id").notNull().references(() => usersTable.id),
  type: text("type").notNull(),
  severity: text("severity").notNull().default("medium"),
  status: text("status").notNull().default("new"),
  priority: boolean("priority").notNull().default(false),
  title: text("title").notNull(),
  description: text("description").notNull(),
  pageUrl: text("page_url"),
  userAgent: text("user_agent"),
  screenshotData: text("screenshot_data"),
  assigneeId: integer("assignee_id").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const feedbackTicketCommentsTable = pgTable("feedback_ticket_comments", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").notNull().references(() => feedbackTicketsTable.id, { onDelete: "cascade" }),
  authorId: integer("author_id").notNull().references(() => usersTable.id),
  body: text("body").notNull(),
  isInternal: boolean("is_internal").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertFeedbackTicketSchema = createInsertSchema(feedbackTicketsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertFeedbackTicket = typeof insertFeedbackTicketSchema._output;
export type FeedbackTicket = typeof feedbackTicketsTable.$inferSelect;

export const insertFeedbackCommentSchema = createInsertSchema(feedbackTicketCommentsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertFeedbackComment = typeof insertFeedbackCommentSchema._output;
export type FeedbackTicketComment = typeof feedbackTicketCommentsTable.$inferSelect;

// Re-export `z` so this file's `z` import isn't flagged as unused; matches
// the convention in audit.ts / notifications.ts.
export const _zRef = z;
