import pg from "pg";
import { sql, type SQL } from "drizzle-orm";
import { logger } from "./logger";
import { defaultHasPermission } from "./roles";
import { sendPwaPushToUser, type PwaPushDeliveryResult } from "./pwaPushSender";
import { decrypt } from "./crypto";
import { NotificationProviderError, sendTwilioSms, setTuyaDeviceSwitch, type SmsCredentials, type TuyaCredentials, type TuyaRegion } from "./notificationProviders";

const { Pool } = pg;
const DEVICE_ALIAS = "MyOrder.fun";
const MAX_ATTEMPTS = 5;
const POLL_MS = 2_000;

type SqlExecutor = { execute: (query: SQL) => Promise<unknown> };
export async function enqueueOrderCreated(tx: SqlExecutor, tenantId: number, orderId: number, createdAt: Date): Promise<void> {
  await tx.execute(sql`INSERT INTO order_print_outbox (tenant_id,order_id,state)
    VALUES (${tenantId},${orderId},'pending') ON CONFLICT (tenant_id,order_id) DO NOTHING`);
  const inserted = await tx.execute(sql`INSERT INTO order_notification_events (tenant_id,order_id,event_type)
    VALUES (${tenantId},${orderId},'ORDER_CREATED') ON CONFLICT DO NOTHING RETURNING id`);
  const event = (Array.isArray(inserted) ? inserted : (inserted as { rows?: Array<{ id: string }> }).rows ?? [])[0] as { id: string } | undefined;
  if (!event) return;
  await tx.execute(sql`INSERT INTO order_notification_jobs (tenant_id,event_id,order_id,notification_type)
    SELECT ${tenantId},${event.id},${orderId},kind FROM (VALUES ('tuya_on'),('staff_sms')) AS kinds(kind)
    ON CONFLICT DO NOTHING`);
  await tx.execute(sql`INSERT INTO order_push_notification_jobs (tenant_id,event_id,order_id,recipient_user_id)
    SELECT ${tenantId},${event.id},${orderId},u.id FROM users u
    WHERE u.tenant_id=${tenantId} AND u.is_active=true AND u.status='approved'
      AND u.role IN ('global_admin','admin','supervisor','csr') AND u.web_push_order_alerts_enabled=true
      AND EXISTS (SELECT 1 FROM pwa_push_subscriptions s WHERE s.tenant_id=u.tenant_id AND s.user_id=u.id AND s.is_active=true)
    ON CONFLICT DO NOTHING`);
  await tx.execute(sql`INSERT INTO order_light_alerts (tenant_id,off_at,generation)
    SELECT ${tenantId},${createdAt}::timestamptz + (s.alert_duration_seconds * interval '1 second'),1
    FROM order_notification_settings s WHERE s.tenant_id=${tenantId} AND s.light_enabled=true
    ON CONFLICT (tenant_id) DO UPDATE SET
      off_at=GREATEST(COALESCE(order_light_alerts.off_at,'-infinity'::timestamptz),EXCLUDED.off_at),
      generation=order_light_alerts.generation+1,updated_at=now()`);
}

type Job = { id: string; tenant_id: number; order_id: number; event_id: string; notification_type: "tuya_on" | "staff_sms"; attempts: number };
type PushJob = { id: string; tenant_id: number; order_id: number; event_id: string; recipient_user_id: number; attempts: number };
type Recipient = { id: number; tenant_id: number | null; role: string; status: string | null; is_active: boolean | null; contact_phone: string | null; notification_preferences: unknown };
type Config = { light_enabled: boolean; sms_enabled: boolean; alert_duration_seconds: number; general_assignee_user_id: number | null; general_fallback_user_id: number | null };
export type NotificationProviders = { light: (on: boolean, tenantId?: number) => Promise<void>; sms: (phone: string, body: string, tenantId?: number) => Promise<string> };

export class NotificationFailure extends Error {
  constructor(readonly classification: "configuration" | "permanent" | "transient" | "uncertain") { super(classification); }
}

export const maskPhone = (value: string) => `***-***-${value.replace(/\D/g, "").slice(-4)}`;
const retryDelay = (attempt: number) => Math.min(300_000, 1_000 * 2 ** Math.min(attempt, 8));
const eligible = (user: Recipient | undefined | null, tenantId: number, role: "csr" | "general") =>
  !!user && user.tenant_id === tenantId && user.is_active !== false && user.status === "approved" &&
  (role === "csr" ? defaultHasPermission(user.role, "queue.claim") : ["admin", "supervisor"].includes(user.role)) &&
  typeof user.contact_phone === "string" && /^\+[1-9]\d{7,14}$/.test(user.contact_phone) &&
  !(user.notification_preferences && typeof user.notification_preferences === "object" &&
    (user.notification_preferences as Record<string, unknown>).smsTexts === false);

async function storedSmsConfig(pool: pg.Pool, tenantId: number): Promise<SmsCredentials> {
  const row = (await pool.query<{ sms_credentials_ciphertext: string | null; sms_sender: string | null }>(
    "SELECT sms_credentials_ciphertext,sms_sender FROM order_notification_settings WHERE tenant_id=$1", [tenantId])).rows[0];
  if (!row?.sms_credentials_ciphertext || !row.sms_sender) throw new NotificationFailure("configuration");
  try { return { ...(JSON.parse(decrypt(row.sms_credentials_ciphertext)) as Omit<SmsCredentials, "sender">), sender: row.sms_sender }; }
  catch { throw new NotificationFailure("configuration"); }
}

async function storedTuyaConfig(pool: pg.Pool, tenantId: number): Promise<{ credentials: TuyaCredentials; deviceId: string; code: string }> {
  const row = (await pool.query<{ tuya_credentials_ciphertext: string | null; tuya_region: string | null; tuya_device_id: string | null; tuya_switch_code: string | null }>(
    "SELECT tuya_credentials_ciphertext,tuya_region,tuya_device_id,tuya_switch_code FROM order_notification_settings WHERE tenant_id=$1", [tenantId])).rows[0];
  if (!row?.tuya_credentials_ciphertext || !row.tuya_region || !row.tuya_device_id || !["us","eu","in","cn","ueaz","weaz"].includes(row.tuya_region)) throw new NotificationFailure("configuration");
  try {
    const value = JSON.parse(decrypt(row.tuya_credentials_ciphertext)) as { clientId?: string; clientSecret?: string };
    if (!value.clientId || !value.clientSecret) throw new Error("invalid");
    return { credentials: { clientId: value.clientId, clientSecret: value.clientSecret, region: row.tuya_region as TuyaRegion }, deviceId: row.tuya_device_id, code: row.tuya_switch_code || "switch_1" };
  } catch { throw new NotificationFailure("configuration"); }
}

function providerFailure(error: unknown): NotificationFailure {
  return new NotificationFailure(error instanceof NotificationProviderError ? error.failure : "transient");
}

export async function sendTuyaSwitch(on: boolean, tenantId?: number, configPool?: pg.Pool): Promise<void> {
  if (!tenantId) throw new NotificationFailure("configuration");
  if (!configPool) throw new NotificationFailure("configuration");
  try { const config = await storedTuyaConfig(configPool, tenantId); await setTuyaDeviceSwitch(config.credentials, config.deviceId, config.code, on); }
  catch (error) { throw providerFailure(error); }
}

export async function sendStaffSms(phone: string, body: string, tenantId?: number, configPool?: pg.Pool): Promise<string> {
  if (!tenantId) throw new NotificationFailure("configuration");
  if (!configPool) throw new NotificationFailure("configuration");
  try { return await sendTwilioSms(await storedSmsConfig(configPool, tenantId), phone, body); }
  catch (error) { throw providerFailure(error); }
}

export async function chooseStaffRecipient(pool: pg.Pool, tenantId: number, orderId: number, config: Config): Promise<Recipient | null> {
  const order = await pool.query<{ assigned_csr_user_id: number | null; assigned_shift_id: number | null; routed_to: string | null }>(
    "SELECT assigned_csr_user_id,assigned_shift_id,routed_to FROM orders WHERE tenant_id=$1 AND id=$2", [tenantId, orderId]);
  const row = order.rows[0];
  if (!row) return null;
  if (row.routed_to === "csr_shift" && row.assigned_csr_user_id && row.assigned_shift_id) {
    const result = await pool.query<Recipient>(`SELECT u.id,u.tenant_id,u.role,u.status,u.is_active,u.contact_phone,u.notification_preferences
      FROM users u JOIN lab_tech_shifts s ON s.tech_id=u.id AND s.tenant_id=u.tenant_id
      WHERE u.tenant_id=$1 AND u.id=$2 AND s.id=$3 AND s.status='active' AND s.clocked_out_at IS NULL
        AND s.box_assignment_id IN ('sales-box-1','sales-box-2')`,
      [tenantId, row.assigned_csr_user_id, row.assigned_shift_id]);
    if (eligible(result.rows[0], tenantId, "csr")) return result.rows[0]!;
  }
  for (const userId of [config.general_assignee_user_id, config.general_fallback_user_id]) {
    if (!userId) continue;
    const result = await pool.query<Recipient>("SELECT id,tenant_id,role,status,is_active,contact_phone,notification_preferences FROM users WHERE tenant_id=$1 AND id=$2", [tenantId, userId]);
    if (eligible(result.rows[0], tenantId, "general")) return result.rows[0]!;
  }
  return null;
}

async function finishJob(pool: pg.Pool, job: Job, state: string, failureClass?: string, recipient?: Recipient, providerReference?: string) {
  await pool.query(`UPDATE order_notification_jobs SET state=$2,failure_class=$3,recipient_user_id=$4,masked_destination=$5,provider_reference=$6,
    completed_at=CASE WHEN $2='queued' THEN NULL ELSE now() END, next_attempt_at=CASE WHEN $2='queued' THEN now()+($7::integer * interval '1 millisecond') ELSE next_attempt_at END,
    lease_until=NULL,updated_at=now() WHERE id=$1`,
    [job.id, state, failureClass ?? null, recipient?.id ?? null, recipient?.contact_phone ? maskPhone(recipient.contact_phone) : null,
      providerReference ?? null, retryDelay(job.attempts)]);
}

async function processLight(pool: pg.Pool, job: Job, providers: NotificationProviders) {
  const client = await pool.connect();
  let needsOn: boolean;
  try {
    await client.query("BEGIN");
    const config = await client.query<Config>("SELECT * FROM order_notification_settings WHERE tenant_id=$1", [job.tenant_id]);
    if (!config.rows[0]?.light_enabled) {
      await client.query("COMMIT"); await finishJob(pool, job, "skipped", "disabled"); return;
    }
    await storedTuyaConfig(pool, job.tenant_id);
    await client.query("INSERT INTO order_light_alerts(tenant_id) VALUES($1) ON CONFLICT DO NOTHING", [job.tenant_id]);
    const current = await client.query<{ is_on: boolean; on_result: string | null }>("SELECT is_on,on_result FROM order_light_alerts WHERE tenant_id=$1 FOR UPDATE", [job.tenant_id]);
    needsOn = !current.rows[0]?.is_on || current.rows[0]?.on_result !== "succeeded";
    // Persist the durable OFF deadline before network I/O. Event creation time
    // makes retries idempotent: they cannot extend the alert window again.
    await client.query(`UPDATE order_light_alerts l SET
      off_at=GREATEST(COALESCE(l.off_at,'-infinity'::timestamptz),e.created_at+($2::integer * interval '1 second')),
      generation=l.generation+1,is_on=true,on_result=CASE WHEN l.is_on THEN l.on_result ELSE 'pending' END,
      off_next_attempt_at=NULL,updated_at=now()
      FROM order_notification_events e WHERE l.tenant_id=$1 AND e.tenant_id=l.tenant_id AND e.id=$3`,
      [job.tenant_id, config.rows[0].alert_duration_seconds, job.event_id]);
    await client.query("COMMIT");
    if (needsOn) await providers.light(true, job.tenant_id);
    await pool.query("UPDATE order_light_alerts SET on_result='succeeded',updated_at=now() WHERE tenant_id=$1", [job.tenant_id]);
    await finishJob(pool, job, "succeeded");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* transaction may already be committed */ }
    const kind = error instanceof NotificationFailure ? error.classification : "transient";
    await finishJob(pool, job, kind === "transient" && job.attempts < MAX_ATTEMPTS ? "queued" : "failed", kind);
  } finally { client.release(); }
}

async function processSms(pool: pg.Pool, job: Job, providers: NotificationProviders) {
  const config = await pool.query<Config>("SELECT * FROM order_notification_settings WHERE tenant_id=$1", [job.tenant_id]);
  if (!config.rows[0]?.sms_enabled) { await finishJob(pool, job, "skipped", "disabled"); return; }
  const recipient = await chooseStaffRecipient(pool, job.tenant_id, job.order_id, config.rows[0]);
  if (!recipient?.contact_phone) { await finishJob(pool, job, "skipped", "no_eligible_recipient"); return; }
  const queue = (await pool.query<{ routed_to: string | null }>("SELECT routed_to FROM orders WHERE tenant_id=$1 AND id=$2", [job.tenant_id, job.order_id])).rows[0]?.routed_to;
  const queueLabel = queue === "csr_shift" && recipient.role === "csr" ? "your queue" : "General Queue";
  const text = `New MyOrder.fun order #${job.order_id} is waiting in ${queueLabel}. Open MyOrder to review and claim it.`;
  try {
    const reference = await providers.sms(recipient.contact_phone, text, job.tenant_id);
    await finishJob(pool, job, "succeeded", undefined, recipient, reference);
  } catch (error) {
    const kind = error instanceof NotificationFailure ? error.classification : "uncertain";
    // A timeout may follow a successful provider acceptance. Never re-send
    // an ambiguous create request without a provider-backed idempotency key.
    const state = kind === "transient" && job.attempts < MAX_ATTEMPTS ? "queued" : kind === "uncertain" ? "uncertain" : "failed";
    await finishJob(pool, job, state, kind, recipient);
  }
}

export async function processDueLightOff(pool: pg.Pool, providers: NotificationProviders): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const due = await client.query<{ tenant_id: number; generation: string; off_at: Date }>(`SELECT tenant_id,generation,off_at FROM order_light_alerts
      WHERE is_on=true AND off_at<=now() AND (off_next_attempt_at IS NULL OR off_next_attempt_at<=now())
        AND EXISTS (SELECT 1 FROM order_notification_settings s WHERE s.tenant_id=order_light_alerts.tenant_id AND s.light_enabled=true AND s.tuya_credentials_ciphertext IS NOT NULL)
      ORDER BY off_at FOR UPDATE SKIP LOCKED LIMIT 1`);
    const current = due.rows[0];
    if (!current) { await client.query("COMMIT"); return false; }
    const again = await client.query<{ generation: string; due: boolean }>("SELECT generation,off_at<=now() AS due FROM order_light_alerts WHERE tenant_id=$1", [current.tenant_id]);
    if (again.rows[0]?.generation !== current.generation || !again.rows[0]?.due) { await client.query("COMMIT"); return true; }
    try {
      await providers.light(false, current.tenant_id);
      await client.query("UPDATE order_light_alerts SET is_on=false,on_result='off',off_at=NULL,off_result='succeeded',off_attempts=0,off_next_attempt_at=NULL,updated_at=now() WHERE tenant_id=$1", [current.tenant_id]);
    } catch {
      await client.query(`UPDATE order_light_alerts SET off_result='failed',off_attempts=off_attempts+1,
        off_next_attempt_at=now()+(LEAST(30000,1000*power(2,LEAST(off_attempts,5))) * interval '1 millisecond'),updated_at=now() WHERE tenant_id=$1`, [current.tenant_id]);
    }
    await client.query("COMMIT"); return true;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function processOneNotificationJob(pool: pg.Pool, providers: NotificationProviders, tenantFilter: number | null = null): Promise<boolean> {
  // Expired SMS leases are uncertain: sending again could duplicate an SMS.
  await pool.query("UPDATE order_notification_jobs SET state='uncertain',failure_class='worker_restart_after_dispatch',lease_until=NULL,updated_at=now() WHERE state='processing' AND notification_type='staff_sms' AND lease_until<now()");
  const result = await pool.query<Job>(`UPDATE order_notification_jobs SET state='processing',attempts=attempts+1,lease_until=now()+interval '30 seconds',updated_at=now()
    WHERE id=(SELECT id FROM order_notification_jobs WHERE (state='queued' OR (state='processing' AND notification_type='tuya_on' AND lease_until<now()))
      AND ($1::integer IS NULL OR tenant_id=$1) AND next_attempt_at<=now() ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [tenantFilter]);
  const job = result.rows[0];
  if (!job) return false;
  try {
    if (job.notification_type === "tuya_on") await processLight(pool, job, providers);
    else await processSms(pool, job, providers);
  } catch {
    await finishJob(pool, job, "failed", "worker_error");
  }
  logger.info({ event: "order_notification_processed", eventId: job.event_id, orderId: job.order_id, tenantId: job.tenant_id,
    notificationType: job.notification_type, attempt: job.attempts, deviceAlias: job.notification_type === "tuya_on" ? DEVICE_ALIAS : undefined }, "Order notification processed");
  return true;
}

export async function processOneOrderPushJob(pool: pg.Pool, send: typeof sendPwaPushToUser = sendPwaPushToUser, tenantFilter: number | null = null): Promise<boolean> {
  // A push-service request may have reached the endpoint before the worker
  // crashed. Mark expired leases uncertain instead of resending blindly.
  await pool.query("UPDATE order_push_notification_jobs SET state='uncertain',failure_class='worker_restart_after_dispatch',lease_until=NULL,completed_at=now(),updated_at=now() WHERE state='processing' AND lease_until<now()");
  const claimed = await pool.query<PushJob>(`UPDATE order_push_notification_jobs SET state='processing',attempts=attempts+1,lease_until=now()+interval '30 seconds',updated_at=now()
    WHERE id=(SELECT id FROM order_push_notification_jobs WHERE state='queued' AND next_attempt_at<=now()
      AND ($1::integer IS NULL OR tenant_id=$1) ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [tenantFilter]);
  const job = claimed.rows[0]; if (!job) return false;
  const order = await pool.query<{ status: string }>("SELECT status FROM orders WHERE tenant_id=$1 AND id=$2", [job.tenant_id, job.order_id]);
  const status = order.rows[0]?.status;
  if (!status) {
    await pool.query("UPDATE order_push_notification_jobs SET state='failed',failure_class='order_missing',completed_at=now(),lease_until=NULL,updated_at=now() WHERE id=$1", [job.id]);
    return true;
  }
  try {
    const result: PwaPushDeliveryResult = await send({ tenantId: job.tenant_id, userId: job.recipient_user_id, payload: {
      type: "order", title: `New order #${job.order_id}`, body: `Order #${job.order_id} ${status === "submitted" || status === "confirmed" ? "awaits processing" : `is ${status}`}.`,
      url: `/orders/${job.order_id}`, tag: `myorder-order-${job.tenant_id}-${job.order_id}`, vibrate: false,
    } });
    let state: string; let failure: string | null = null;
    if (result.skipped || result.attempted === 0) { state = "skipped"; failure = "recipient_disabled_or_subscription_missing"; }
    else if (result.sent > 0) { state = "succeeded"; }
    else if (result.retryable > 0 && job.attempts < MAX_ATTEMPTS) { state = "queued"; failure = "push_service_rate_limited"; }
    else { state = result.uncertain > 0 ? "uncertain" : "failed"; failure = result.uncertain > 0 ? "push_delivery_uncertain" : "push_delivery_failed"; }
    await pool.query(`UPDATE order_push_notification_jobs SET state=$2,failure_class=$3,lease_until=NULL,
      next_attempt_at=CASE WHEN $2='queued' THEN now()+($4::integer*interval '1 millisecond') ELSE next_attempt_at END,
      completed_at=CASE WHEN $2 IN ('queued','processing') THEN NULL ELSE now() END,updated_at=now() WHERE id=$1`,
    [job.id,state,failure,retryDelay(job.attempts)]);
  } catch {
    await pool.query("UPDATE order_push_notification_jobs SET state='uncertain',failure_class='push_delivery_uncertain',lease_until=NULL,completed_at=now(),updated_at=now() WHERE id=$1", [job.id]);
  }
  return true;
}

let timer: NodeJS.Timeout | null = null;
export function startOrderNotificationWorker(providers?: NotificationProviders) {
  if (process.env.ORDER_NOTIFICATION_WORKER_ENABLED !== "1" || timer) return;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ...(process.env.DB_SSL === "false" ? { ssl: false } : {}) });
  const activeProviders: NotificationProviders = providers ?? {
    light: (on, tenantId) => sendTuyaSwitch(on, tenantId, pool),
    sms: (phone, body, tenantId) => sendStaffSms(phone, body, tenantId, pool),
  };
  let running = false;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processDueLightOff(pool, activeProviders);
      for (let i = 0; i < 5; i++) if (!(await processOneNotificationJob(pool, activeProviders))) break;
      for (let i = 0; i < 10; i++) if (!(await processOneOrderPushJob(pool))) break;
    } catch { logger.warn({ event: "order_notification_worker_failure", failureClass: "database_or_worker" }, "Order notification worker will retry"); }
    finally { running = false; }
  }, POLL_MS);
  timer.unref();
}
