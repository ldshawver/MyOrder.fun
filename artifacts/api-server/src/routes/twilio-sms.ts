import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { sendPwaPushToTenant } from "../lib/pwaPushSender";

const router: IRouter = Router();

let ensured = false;
async function ensureInboundSmsTable(): Promise<void> {
  if (ensured) return;
  const { db } = await import("@workspace/db");
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS inbound_sms_messages (
      id serial PRIMARY KEY,
      message_sid text UNIQUE,
      from_number text,
      to_number text,
      body text,
      tenant_id integer REFERENCES tenants(id) ON DELETE SET NULL,
      provider_payload jsonb,
      created_at timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  ensured = true;
}

async function storeInboundSms(input: { messageSid: string | null; from: string | null; to: string | null; body: string | null; providerPayload: unknown }): Promise<{ id: number | null; tenantId: number | null }> {
  const { db } = await import("@workspace/db");
  await ensureInboundSmsTable();
  const result = await db.execute(sql`
    INSERT INTO inbound_sms_messages (message_sid, from_number, to_number, body, provider_payload)
    VALUES (${input.messageSid}, ${input.from}, ${input.to}, ${input.body}, ${JSON.stringify(input.providerPayload)}::jsonb)
    ON CONFLICT (message_sid) DO UPDATE SET provider_payload = EXCLUDED.provider_payload
    RETURNING id, tenant_id
  `);
  const row = (result as { rows?: Array<{ id?: number; tenant_id?: number | null }> }).rows?.[0];
  return { id: row?.id ?? null, tenantId: row?.tenant_id ?? null };
}

router.post("/twilio/sms/inbound", async (req, res): Promise<void> => {
  const messageSid = typeof req.body?.MessageSid === "string" ? req.body.MessageSid : null;
  const from = typeof req.body?.From === "string" ? req.body.From : null;
  const to = typeof req.body?.To === "string" ? req.body.To : null;
  const body = typeof req.body?.Body === "string" ? req.body.Body : null;

  try {
    const stored = await storeInboundSms({ messageSid, from, to, body, providerPayload: req.body ?? {} });
    const pushResult = await sendPwaPushToTenant({
      tenantId: stored.tenantId,
      payload: {
        type: "sms",
        title: "New SMS message",
        body: body ? `New SMS from ${from ?? "unknown"}: ${body.slice(0, 120)}` : `New SMS from ${from ?? "unknown"}`,
        url: "/sms-calls",
        tag: `sms-${messageSid ?? stored.id ?? Date.now()}`,
        badgeCount: 1,
        vibrate: [120, 60, 120],
      },
    });
    logger.info({ event: "inbound_sms_stored_push_requested", smsId: stored.id, tenantId: stored.tenantId, pushAttempted: pushResult.attempted, pushSent: pushResult.sent, pushFailed: pushResult.failed, pushSkipped: pushResult.skipped }, "Inbound SMS stored and PWA push requested");
    res.type("text/xml").status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (err) {
    logger.error({ err, event: "inbound_sms_failed" }, "Inbound SMS handling failed");
    res.type("text/xml").status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
});

export default router;
