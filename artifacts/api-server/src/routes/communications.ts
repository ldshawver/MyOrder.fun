import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { z } from "zod/v4";
import twilio from "twilio";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole } from "../lib/auth";
import { getBusinessSmsNumber, normalizePhoneNumber, sanitizeSmsBody, sendSmsDetailed } from "../lib/sms";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const STAFF_ROLES = ["global_admin", "admin", "csr"] as const;
const GOOGLE_CONTACT_SCOPES = "https://www.googleapis.com/auth/contacts.readonly";

type DbRow = Record<string, unknown>;

type ContactRow = {
  id: number;
  display_name: string | null;
  phone_e164: string | null;
  email: string | null;
  source: string | null;
  updated_at: Date | string;
};

type SmsThreadRow = {
  id: number;
  contact_phone: string;
  contact_name: string | null;
  last_message_at: Date | string | null;
  last_message_preview: string | null;
  unread_count: number | string | null;
};

type SmsMessageRow = {
  id: number;
  direction: string;
  from_phone: string;
  to_phone: string;
  body: string;
  status: string | null;
  twilio_sid: string | null;
  error_message: string | null;
  created_at: Date | string;
};

type GoogleConnectionRow = {
  id: number;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: Date | string | null;
  connected_email: string | null;
  last_sync_at: Date | string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
};

function getBaseUrl(req: { protocol: string; get(name: string): string | undefined }): string {
  return (process.env.PUBLIC_API_BASE_URL ?? `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function ensureCommunicationsSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS google_contact_connections (
      id serial PRIMARY KEY,
      user_id integer NOT NULL,
      tenant_id integer,
      state text NOT NULL UNIQUE,
      access_token text,
      refresh_token text,
      expires_at timestamptz,
      connected_email text,
      last_sync_at timestamptz,
      last_sync_status text,
      last_sync_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_cache (
      id serial PRIMARY KEY,
      user_id integer NOT NULL,
      tenant_id integer,
      source text NOT NULL DEFAULT 'google',
      source_contact_id text,
      display_name text,
      phone_e164 text,
      email text,
      raw jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS contact_cache_phone_idx ON contact_cache (phone_e164)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS contact_cache_user_search_idx ON contact_cache (user_id, lower(coalesce(display_name, '')), phone_e164)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sms_threads (
      id serial PRIMARY KEY,
      tenant_id integer,
      owner_user_id integer,
      contact_phone text NOT NULL,
      contact_name text,
      last_message_at timestamptz,
      last_message_preview text,
      unread_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (owner_user_id, contact_phone)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sms_messages (
      id serial PRIMARY KEY,
      thread_id integer REFERENCES sms_threads(id),
      tenant_id integer,
      actor_user_id integer,
      direction text NOT NULL,
      from_phone text NOT NULL,
      to_phone text NOT NULL,
      body text NOT NULL,
      status text,
      twilio_sid text,
      error_message text,
      raw jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS sms_messages_thread_created_idx ON sms_messages (thread_id, created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS sms_messages_sid_idx ON sms_messages (twilio_sid)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_calls (
      id serial PRIMARY KEY,
      tenant_id integer,
      actor_user_id integer,
      contact_phone text NOT NULL,
      contact_name text,
      business_number text,
      direction text NOT NULL DEFAULT 'outbound',
      status text NOT NULL DEFAULT 'queued',
      twilio_sid text,
      call_provider text NOT NULL DEFAULT 'native_twilio',
      error_message text,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      raw jsonb
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS business_calls_actor_started_idx ON business_calls (actor_user_id, started_at DESC)`);
}

async function lookupContactName(userId: number | null, phone: string): Promise<string | null> {
  const result = await pool.query<ContactRow>(
    `SELECT display_name, phone_e164 FROM contact_cache
     WHERE phone_e164 = $1 AND ($2::integer IS NULL OR user_id = $2)
     ORDER BY CASE WHEN user_id = $2 THEN 0 ELSE 1 END, updated_at DESC
     LIMIT 1`,
    [phone, userId],
  );
  return result.rows[0]?.display_name ?? null;
}

async function upsertThread(input: { userId: number | null; tenantId: number | null; phone: string; name?: string | null; preview: string; inbound?: boolean }): Promise<number> {
  const name = input.name ?? await lookupContactName(input.userId, input.phone);
  const result = await pool.query<{ id: number }>(
    `INSERT INTO sms_threads (owner_user_id, tenant_id, contact_phone, contact_name, last_message_at, last_message_preview, unread_count, updated_at)
     VALUES ($1, $2, $3, $4, now(), $5, $6, now())
     ON CONFLICT (owner_user_id, contact_phone) DO UPDATE SET
       contact_name = coalesce(EXCLUDED.contact_name, sms_threads.contact_name),
       last_message_at = now(),
       last_message_preview = EXCLUDED.last_message_preview,
       unread_count = sms_threads.unread_count + EXCLUDED.unread_count,
       updated_at = now()
     RETURNING id`,
    [input.userId, input.tenantId, input.phone, name, input.preview, input.inbound ? 1 : 0],
  );
  return result.rows[0].id;
}

async function recordSmsMessage(input: {
  threadId: number;
  tenantId: number | null;
  actorUserId: number | null;
  direction: "inbound" | "outbound";
  fromPhone: string;
  toPhone: string;
  body: string;
  status: string;
  sid?: string | null;
  error?: string | null;
  raw?: unknown;
}): Promise<void> {
  await pool.query(
    `INSERT INTO sms_messages (thread_id, tenant_id, actor_user_id, direction, from_phone, to_phone, body, status, twilio_sid, error_message, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [input.threadId, input.tenantId, input.actorUserId, input.direction, input.fromPhone, input.toPhone, input.body, input.status, input.sid, input.error, JSON.stringify(input.raw ?? {})],
  );
}

function mapThread(row: SmsThreadRow) {
  return {
    id: row.id,
    contactPhone: row.contact_phone,
    contactName: row.contact_name,
    lastMessageAt: toIso(row.last_message_at),
    lastMessagePreview: row.last_message_preview,
    unreadCount: Number(row.unread_count ?? 0),
  };
}

function mapMessage(row: SmsMessageRow) {
  return {
    id: row.id,
    direction: row.direction,
    fromPhone: row.from_phone,
    toPhone: row.to_phone,
    body: row.body,
    status: row.status,
    twilioSid: row.twilio_sid,
    errorMessage: row.error_message,
    createdAt: toIso(row.created_at),
  };
}

const protectedRouter: IRouter = Router();
protectedRouter.use(requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole(...STAFF_ROLES));

protectedRouter.get("/communications/health", async (req, res) => {
  await ensureCommunicationsSchema();
  const actor = req.dbUser!;
  const [connection, contacts, threads, messages] = await Promise.all([
    pool.query<GoogleConnectionRow>(`SELECT * FROM google_contact_connections WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`, [actor.id]),
    pool.query<{ count: string }>(`SELECT count(*) FROM contact_cache WHERE user_id = $1`, [actor.id]),
    pool.query<{ count: string }>(`SELECT count(*) FROM sms_threads WHERE owner_user_id = $1`, [actor.id]),
    pool.query<{ count: string }>(`SELECT count(*) FROM sms_messages WHERE actor_user_id = $1 OR thread_id IN (SELECT id FROM sms_threads WHERE owner_user_id = $1)`, [actor.id]),
  ]);
  const c = connection.rows[0];
  res.json({
    twilio: {
      configured: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && getBusinessSmsNumber()),
      businessNumber: getBusinessSmsNumber() ?? process.env.BUSINESS_PHONE_NUMBER ?? null,
      voiceConfigured: Boolean(process.env.TWILIO_VOICE_TWIML_URL || process.env.TWILIO_CALL_HANDLER_URL),
    },
    googleContacts: {
      oauthConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      connected: Boolean(c?.access_token || c?.refresh_token),
      connectedEmail: c?.connected_email ?? null,
      lastSyncAt: toIso(c?.last_sync_at),
      lastSyncStatus: c?.last_sync_status ?? null,
      lastSyncError: c?.last_sync_error ?? null,
      cachedContacts: Number(contacts.rows[0]?.count ?? 0),
    },
    sms: {
      threads: Number(threads.rows[0]?.count ?? 0),
      messages: Number(messages.rows[0]?.count ?? 0),
    },
  });
});

protectedRouter.get("/communications/google/oauth-url", async (req, res) => {
  await ensureCommunicationsSchema();
  const actor = req.dbUser!;
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    res.status(503).json({ error: "Google OAuth is not configured" });
    return;
  }
  const state = `${actor.id}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  await pool.query(
    `INSERT INTO google_contact_connections (user_id, tenant_id, state, last_sync_status)
     VALUES ($1, $2, $3, 'oauth_started')
     ON CONFLICT (state) DO NOTHING`,
    [actor.id, actor.tenantId ?? null, state],
  );
  const redirectUri = `${getBaseUrl(req)}/api/communications/google/callback`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_CONTACT_SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  res.json({ url: url.toString(), redirectUri });
});

protectedRouter.post("/communications/google/sync", async (req, res) => {
  await ensureCommunicationsSchema();
  const actor = req.dbUser!;
  const summary = await syncGoogleContacts(actor.id, actor.tenantId ?? null);
  res.json(summary);
});

protectedRouter.get("/communications/contacts", async (req, res) => {
  await ensureCommunicationsSchema();
  const actor = req.dbUser!;
  const q = String(req.query.q ?? "").trim();
  const limit = Math.min(Math.max(Number(req.query.limit ?? 25), 1), 100);
  const pattern = `%${q.toLowerCase()}%`;
  const rows = await pool.query<ContactRow>(
    `SELECT id, display_name, phone_e164, email, source, updated_at FROM contact_cache
     WHERE user_id = $1 AND ($2 = '' OR lower(coalesce(display_name, '')) LIKE $3 OR coalesce(phone_e164, '') LIKE $3 OR lower(coalesce(email, '')) LIKE $3)
     ORDER BY lower(coalesce(display_name, phone_e164, email, '')) ASC
     LIMIT $4`,
    [actor.id, q, pattern, limit],
  );
  res.json({ contacts: rows.rows.map(row => ({ id: row.id, displayName: row.display_name, phone: row.phone_e164, email: row.email, source: row.source, updatedAt: toIso(row.updated_at) })) });
});

protectedRouter.get("/communications/sms/threads", async (req, res) => {
  await ensureCommunicationsSchema();
  const actor = req.dbUser!;
  const rows = await pool.query<SmsThreadRow>(
    `SELECT * FROM sms_threads WHERE owner_user_id = $1 ORDER BY coalesce(last_message_at, created_at) DESC LIMIT 100`,
    [actor.id],
  );
  res.json({ threads: rows.rows.map(mapThread) });
});

protectedRouter.get("/communications/sms/threads/:id/messages", async (req, res) => {
  await ensureCommunicationsSchema();
  const actor = req.dbUser!;
  const id = Number(req.params.id);
  const thread = await pool.query<SmsThreadRow>(`SELECT * FROM sms_threads WHERE id = $1 AND owner_user_id = $2`, [id, actor.id]);
  if (!thread.rows[0]) {
    res.status(404).json({ error: "SMS thread not found" });
    return;
  }
  await pool.query(`UPDATE sms_threads SET unread_count = 0 WHERE id = $1`, [id]);
  const rows = await pool.query<SmsMessageRow>(`SELECT * FROM sms_messages WHERE thread_id = $1 ORDER BY created_at ASC, id ASC`, [id]);
  res.json({ thread: mapThread({ ...thread.rows[0], unread_count: 0 }), messages: rows.rows.map(mapMessage) });
});

const SendSmsBody = z.object({
  threadId: z.number().int().positive().optional(),
  to: z.string().optional(),
  body: z.string().trim().min(1).max(1500),
});

protectedRouter.post("/communications/sms/send", async (req, res) => {
  await ensureCommunicationsSchema();
  const actor = req.dbUser!;
  const parsed = SendSmsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let to = normalizePhoneNumber(parsed.data.to);
  let threadId = parsed.data.threadId ?? null;
  if (threadId) {
    const found = await pool.query<SmsThreadRow>(`SELECT * FROM sms_threads WHERE id = $1 AND owner_user_id = $2`, [threadId, actor.id]);
    if (!found.rows[0]) {
      res.status(404).json({ error: "SMS thread not found" });
      return;
    }
    to = found.rows[0].contact_phone;
  }
  if (!to) {
    res.status(400).json({ error: "A valid recipient or thread is required" });
    return;
  }

  const body = sanitizeSmsBody(parsed.data.body);
  const from = getBusinessSmsNumber() ?? process.env.BUSINESS_PHONE_NUMBER ?? "business-number-not-configured";
  threadId = threadId ?? await upsertThread({ userId: actor.id, tenantId: actor.tenantId ?? null, phone: to, preview: body });
  const callback = `${getBaseUrl(req)}/api/communications/twilio/status`;
  const result = await sendSmsDetailed(to, body, callback);
  await recordSmsMessage({
    threadId,
    tenantId: actor.tenantId ?? null,
    actorUserId: actor.id,
    direction: "outbound",
    fromPhone: result.from ?? from,
    toPhone: to,
    body,
    status: result.success ? "queued" : result.skipped ? "skipped" : "failed",
    sid: result.sid,
    error: result.error,
    raw: result,
  });
  await pool.query(`UPDATE sms_threads SET last_message_at = now(), last_message_preview = $1, updated_at = now() WHERE id = $2`, [body, threadId]);
  if (!result.success) {
    logger.error({ result, threadId, userId: actor.id }, "Business SMS dispatch failed");
    res.status(result.skipped ? 503 : 502).json({ error: result.error ?? "SMS dispatch failed", threadId });
    return;
  }
  res.json({ ok: true, threadId, sid: result.sid, status: "queued", from: result.from, to });
});

const CreateCallBody = z.object({
  to: z.string().optional(),
  contactName: z.string().optional(),
});

protectedRouter.get("/communications/calls/recent", async (req, res) => {
  await ensureCommunicationsSchema();
  const actor = req.dbUser!;
  const rows = await pool.query<DbRow>(
    `SELECT * FROM business_calls WHERE actor_user_id = $1 ORDER BY started_at DESC LIMIT 50`,
    [actor.id],
  );
  res.json({ calls: rows.rows.map(row => ({
    id: row.id,
    contactPhone: row.contact_phone,
    contactName: row.contact_name,
    businessNumber: row.business_number,
    direction: row.direction,
    status: row.status,
    twilioSid: row.twilio_sid,
    provider: row.call_provider,
    errorMessage: row.error_message,
    startedAt: toIso(row.started_at as Date | string | null),
    endedAt: toIso(row.ended_at as Date | string | null),
  })) });
});

protectedRouter.get("/communications/calls/missed", async (req, res) => {
  await ensureCommunicationsSchema();
  const actor = req.dbUser!;
  const rows = await pool.query<DbRow>(
    `SELECT * FROM business_calls WHERE actor_user_id = $1 AND status IN ('no-answer', 'busy', 'missed') ORDER BY started_at DESC LIMIT 50`,
    [actor.id],
  );
  res.json({ calls: rows.rows });
});

protectedRouter.get("/communications/voicemail", async (_req, res) => {
  await ensureCommunicationsSchema();
  res.json({ voicemails: [], note: "No voicemail provider webhook is configured yet; native voicemail records will appear here once Twilio recordings are enabled." });
});

protectedRouter.post("/communications/calls", async (req, res) => {
  await ensureCommunicationsSchema();
  const actor = req.dbUser!;
  const parsed = CreateCallBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const to = normalizePhoneNumber(parsed.data.to);
  if (!to) {
    res.status(400).json({ error: "A valid phone number is required" });
    return;
  }
  const businessNumber = getBusinessSmsNumber() ?? process.env.BUSINESS_PHONE_NUMBER ?? null;
  const name = parsed.data.contactName ?? await lookupContactName(actor.id, to);
  let status: string;
  let sid: string | null = null;
  let error: string | null = null;

  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && businessNumber && (process.env.TWILIO_VOICE_TWIML_URL || process.env.TWILIO_CALL_HANDLER_URL)) {
    try {
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const call = await client.calls.create({
        to,
        from: businessNumber,
        url: process.env.TWILIO_VOICE_TWIML_URL ?? process.env.TWILIO_CALL_HANDLER_URL!,
      });
      sid = call.sid;
      status = call.status ?? "queued";
    } catch (err) {
      error = err instanceof Error ? err.message : "Call dispatch failed";
      status = "failed";
      logger.error({ err, to, userId: actor.id }, "Business call dispatch failed");
    }
  } else {
    status = "manual_ready";
    error = "Twilio Voice is not fully configured; use the native tel link fallback.";
  }

  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO business_calls (tenant_id, actor_user_id, contact_phone, contact_name, business_number, status, twilio_sid, error_message, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING id`,
    [actor.tenantId ?? null, actor.id, to, name, businessNumber, status, sid, error, JSON.stringify({ native: true })],
  );
  res.status(status === "failed" ? 502 : 200).json({ id: inserted.rows[0].id, status, sid, businessNumber, to, contactName: name, telHref: `tel:${to}`, error });
});

async function refreshGoogleToken(connection: GoogleConnectionRow): Promise<string | null> {
  if (connection.access_token && connection.expires_at && new Date(connection.expires_at).getTime() > Date.now() + 60_000) {
    return connection.access_token;
  }
  if (!connection.refresh_token || !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return connection.access_token;
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: connection.refresh_token,
    }),
  });
  const tokenJson = await tokenRes.json() as Record<string, unknown>;
  if (!tokenRes.ok) throw new Error(asString(tokenJson.error_description) ?? "Google token refresh failed");
  const accessToken = asString(tokenJson.access_token);
  if (!accessToken) throw new Error("Google token refresh did not return an access token");
  const expiresIn = typeof tokenJson.expires_in === "number" ? tokenJson.expires_in : 3600;
  await pool.query(`UPDATE google_contact_connections SET access_token = $1, expires_at = now() + ($2 || ' seconds')::interval, updated_at = now() WHERE id = $3`, [accessToken, expiresIn, connection.id]);
  return accessToken;
}

async function syncGoogleContacts(userId: number, tenantId: number | null) {
  const connections = await pool.query<GoogleConnectionRow>(`SELECT * FROM google_contact_connections WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`, [userId]);
  const connection = connections.rows[0];
  if (!connection) throw new Error("Google Contacts is not connected");
  try {
    const token = await refreshGoogleToken(connection);
    if (!token) throw new Error("Google Contacts is missing an access token");
    let pageToken: string | null = null;
    let imported = 0;
    do {
      const url = new URL("https://people.googleapis.com/v1/people/me/connections");
      url.searchParams.set("personFields", "names,emailAddresses,phoneNumbers");
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const peopleRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const peopleJson = await peopleRes.json() as Record<string, unknown>;
      if (!peopleRes.ok) throw new Error(asString(peopleJson.error) ?? "Google People API sync failed");
      const connectionsJson = Array.isArray(peopleJson.connections) ? peopleJson.connections as Record<string, unknown>[] : [];
      for (const person of connectionsJson) {
        const names = Array.isArray(person.names) ? person.names as Record<string, unknown>[] : [];
        const phones = Array.isArray(person.phoneNumbers) ? person.phoneNumbers as Record<string, unknown>[] : [];
        const emails = Array.isArray(person.emailAddresses) ? person.emailAddresses as Record<string, unknown>[] : [];
        const displayName = asString(names[0]?.displayName) ?? asString(names[0]?.unstructuredName);
        const email = asString(emails[0]?.value);
        const sourceContactId = asString(person.resourceName);
        for (const phone of phones) {
          const normalized = normalizePhoneNumber(asString(phone.canonicalForm) ?? asString(phone.value));
          if (!normalized) continue;
          await pool.query(
            `INSERT INTO contact_cache (user_id, tenant_id, source, source_contact_id, display_name, phone_e164, email, raw, updated_at)
             VALUES ($1, $2, 'google', $3, $4, $5, $6, $7::jsonb, now())
             ON CONFLICT DO NOTHING`,
            [userId, tenantId, sourceContactId, displayName, normalized, email, JSON.stringify(person)],
          );
          await pool.query(
            `UPDATE contact_cache SET display_name = $1, email = $2, raw = $3::jsonb, updated_at = now()
             WHERE user_id = $4 AND phone_e164 = $5`,
            [displayName, email, JSON.stringify(person), userId, normalized],
          );
          imported += 1;
        }
      }
      pageToken = asString(peopleJson.nextPageToken);
    } while (pageToken);
    await pool.query(`UPDATE google_contact_connections SET last_sync_at = now(), last_sync_status = 'success', last_sync_error = NULL, updated_at = now() WHERE id = $1`, [connection.id]);
    return { ok: true, imported, lastSyncStatus: "success" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Google Contacts sync failed";
    await pool.query(`UPDATE google_contact_connections SET last_sync_at = now(), last_sync_status = 'error', last_sync_error = $1, updated_at = now() WHERE id = $2`, [message, connection.id]);
    throw err;
  }
}

router.get("/communications/google/callback", async (req, res) => {
  await ensureCommunicationsSchema();
  const code = String(req.query.code ?? "");
  const state = String(req.query.state ?? "");
  if (!code || !state || !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    res.status(400).send("Google Contacts connection failed: missing code, state, or OAuth config.");
    return;
  }
  const connectionRes = await pool.query<GoogleConnectionRow & { user_id: number; tenant_id: number | null }>(`SELECT * FROM google_contact_connections WHERE state = $1`, [state]);
  const connection = connectionRes.rows[0];
  if (!connection) {
    res.status(400).send("Google Contacts connection failed: invalid state.");
    return;
  }
  const redirectUri = `${getBaseUrl(req)}/api/communications/google/callback`;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    const tokenJson = await tokenRes.json() as Record<string, unknown>;
    if (!tokenRes.ok) throw new Error(asString(tokenJson.error_description) ?? "Google token exchange failed");
    const accessToken = asString(tokenJson.access_token);
    const refreshToken = asString(tokenJson.refresh_token) ?? connection.refresh_token;
    const expiresIn = typeof tokenJson.expires_in === "number" ? tokenJson.expires_in : 3600;
    if (!accessToken) throw new Error("Google did not return an access token");
    await pool.query(
      `UPDATE google_contact_connections SET access_token = $1, refresh_token = $2, expires_at = now() + ($3 || ' seconds')::interval, last_sync_status = 'connected', updated_at = now() WHERE id = $4`,
      [accessToken, refreshToken, expiresIn, connection.id],
    );
    await syncGoogleContacts(connection.user_id, connection.tenant_id);
    res.redirect("/communications?google=connected");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Google Contacts connection failed";
    await pool.query(`UPDATE google_contact_connections SET last_sync_status = 'error', last_sync_error = $1, updated_at = now() WHERE id = $2`, [message, connection.id]);
    res.status(502).send(`Google Contacts connection failed: ${message}`);
  }
});

router.post("/communications/twilio/status", async (req, res) => {
  await ensureCommunicationsSchema();
  const sid = asString(req.body.MessageSid) ?? asString(req.body.SmsSid);
  const status = asString(req.body.MessageStatus) ?? asString(req.body.SmsStatus);
  if (sid && status) {
    await pool.query(`UPDATE sms_messages SET status = $1, raw = coalesce(raw, '{}'::jsonb) || $2::jsonb, updated_at = now() WHERE twilio_sid = $3`, [status, JSON.stringify(req.body), sid]);
  }
  res.type("text/plain").send("ok");
});

router.post("/communications/twilio/incoming", async (req, res) => {
  await ensureCommunicationsSchema();
  const from = normalizePhoneNumber(asString(req.body.From));
  const to = normalizePhoneNumber(asString(req.body.To)) ?? getBusinessSmsNumber();
  const body = sanitizeSmsBody(asString(req.body.Body) ?? "");
  if (!from || !to || !body) {
    res.type("text/xml").send("<Response></Response>");
    return;
  }
  const staff = await pool.query<{ id: number; tenant_id: number | null }>(
    `SELECT id, tenant_id FROM users WHERE role IN ('global_admin', 'admin', 'supervisor', 'csr') AND coalesce(is_active, true) = true ORDER BY id ASC LIMIT 1`,
  );
  const owner = staff.rows[0] ?? { id: null, tenant_id: null };
  const name = await lookupContactName(owner.id, from);
  const threadId = await upsertThread({ userId: owner.id, tenantId: owner.tenant_id, phone: from, name, preview: body, inbound: true });
  await recordSmsMessage({ threadId, tenantId: owner.tenant_id, actorUserId: null, direction: "inbound", fromPhone: from, toPhone: to, body, status: "received", sid: asString(req.body.MessageSid), raw: req.body });
  logger.info({ from, to, threadId, contactName: name }, "Inbound SMS recorded");
  res.type("text/xml").send("<Response></Response>");
});

router.use(protectedRouter);

export default router;
