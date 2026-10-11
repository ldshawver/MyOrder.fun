import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { runWooCatalogSync } from "../routes/woocommerce";

const POLL_MS = 2_000;
const LEASE_MS = 90_000;
const MAX_ATTEMPTS = 4;

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | undefined)?.rows ?? []);
}

export async function enqueueWooSync(tenantId: number, actorId: number): Promise<{ id: string; reused: boolean }> {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(781244, ${tenantId})`);
    const active = rows<{ id: string }>(await tx.execute(sql`SELECT id FROM woocommerce_sync_jobs
      WHERE tenant_id=${tenantId} AND state IN ('queued','running','interrupted') ORDER BY created_at LIMIT 1`))[0];
    if (active) return { id: active.id, reused: true };
    const id = randomUUID();
    await tx.execute(sql`INSERT INTO woocommerce_sync_jobs (id,tenant_id,requested_by,state)
      VALUES (${id},${tenantId},${actorId},'queued')`);
    return { id, reused: false };
  });
}

async function recoverExpiredLeases(): Promise<void> {
  await db.execute(sql`UPDATE woocommerce_sync_jobs SET state='interrupted',lease_owner=NULL,lease_until=NULL,
    last_error_code='worker_interrupted',updated_at=now()
    WHERE state='running' AND lease_until < now()`);
  await db.execute(sql`UPDATE woocommerce_sync_jobs SET state='failed',completed_at=now(),
    last_error_code='retry_limit_reached',updated_at=now()
    WHERE state='interrupted' AND attempt_count >= ${MAX_ATTEMPTS}`);
}

async function claimOne(owner: string): Promise<{ id: string; tenant_id: number } | null> {
  const claimed = rows<{ id: string; tenant_id: number }>(await db.execute(sql`WITH candidate AS (
      SELECT id FROM woocommerce_sync_jobs WHERE state IN ('queued','interrupted') AND attempt_count < ${MAX_ATTEMPTS}
      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE woocommerce_sync_jobs j SET state='running',attempt_count=j.attempt_count+1,lease_owner=${owner},
      lease_until=now()+(${LEASE_MS} * interval '1 millisecond'),heartbeat_at=now(),started_at=COALESCE(j.started_at,now()),
      processed_parents=0,total_parents=0,processed_variants=0,total_variants=0,
      created_count=0,updated_count=0,skipped_count=0,failed_count=0,error_summary='[]'::jsonb,
      last_error_code=CASE WHEN j.state='interrupted' THEN 'worker_recovered' ELSE NULL END,updated_at=now()
    FROM candidate WHERE j.id=candidate.id RETURNING j.id,j.tenant_id`));
  return claimed[0] ?? null;
}

async function markFailure(jobId: string, owner: string, code: string): Promise<void> {
  await db.execute(sql`UPDATE woocommerce_sync_jobs SET state=CASE WHEN attempt_count < ${MAX_ATTEMPTS} THEN 'interrupted' ELSE 'failed' END,
    lease_owner=NULL,lease_until=NULL,last_error_code=${code},error_summary=jsonb_build_array(jsonb_build_object('code',CAST(${code} AS text))),
    completed_at=CASE WHEN attempt_count >= ${MAX_ATTEMPTS} THEN now() ELSE NULL END,updated_at=now()
    WHERE id=${jobId} AND state='running' AND lease_owner=${owner}`);
}

async function processOne(run: typeof runWooCatalogSync): Promise<boolean> {
  const owner = randomUUID();
  const job = await claimOne(owner);
  if (!job) return false;
  let heartbeatBusy = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try { await db.execute(sql`UPDATE woocommerce_sync_jobs SET lease_until=now()+(${LEASE_MS} * interval '1 millisecond'),heartbeat_at=now(),updated_at=now()
      WHERE id=${job.id} AND state='running' AND lease_owner=${owner}`); }
    catch { logger.warn({ event: "woocommerce_sync_heartbeat_failed", jobId: job.id }, "Woo sync lease heartbeat failed"); }
    finally { heartbeatBusy = false; }
  }, 15_000);
  heartbeat.unref();
  try {
    const summary = await run(job.tenant_id, async progress => {
      await db.execute(sql`UPDATE woocommerce_sync_jobs SET
        processed_parents=${progress.parentsCreated + progress.parentsUpdated + progress.skipped + progress.failed},
        total_parents=${progress.totalParents},processed_variants=${progress.variantsCreated + progress.variantsUpdated},
        total_variants=${progress.totalVariants},created_count=${progress.parentsCreated + progress.variantsCreated},
        updated_count=${progress.parentsUpdated + progress.variantsUpdated},skipped_count=${progress.skipped},failed_count=${progress.failed},
        error_summary=${JSON.stringify(progress.errors)}::jsonb,updated_at=now(),heartbeat_at=now(),
        lease_until=now()+(${LEASE_MS} * interval '1 millisecond')
        WHERE id=${job.id} AND state='running' AND lease_owner=${owner}`);
    });
    const hasErrors = summary.failed > 0;
    await db.execute(sql`UPDATE woocommerce_sync_jobs SET state=${hasErrors ? "failed" : "succeeded"},
      processed_parents=${summary.totalParents},total_parents=${summary.totalParents},
      processed_variants=${summary.totalVariants},total_variants=${summary.totalVariants},
      created_count=${summary.parentsCreated + summary.variantsCreated},updated_count=${summary.parentsUpdated + summary.variantsUpdated},
      skipped_count=${summary.skipped},failed_count=${summary.failed},error_summary=${JSON.stringify(summary.errors)}::jsonb,
      last_error_code=${hasErrors ? "product_import_failed" : null},lease_owner=NULL,lease_until=NULL,completed_at=now(),updated_at=now()
      WHERE id=${job.id} AND state='running' AND lease_owner=${owner}`);
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message) ? error.message : "sync_failed";
    await markFailure(job.id, owner, code);
    logger.warn({ event: "woocommerce_sync_job_failed", jobId: job.id, tenantId: job.tenant_id, errorCode: code }, "Woo sync job failed");
  } finally { clearInterval(heartbeat); }
  return true;
}

/** One worker iteration exposed for deterministic disposable-DB tests. */
export async function runWooSyncWorkerOnce(run: typeof runWooCatalogSync = runWooCatalogSync): Promise<boolean> {
  await recoverExpiredLeases();
  return processOne(run);
}

let timer: NodeJS.Timeout | null = null;
export function startWooSyncWorker(run: typeof runWooCatalogSync = runWooCatalogSync): void {
  if (process.env.WOOCOMMERCE_SYNC_WORKER_ENABLED === "0" || timer) return;
  let running = false;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      // Limit one complete catalog per worker tick; a job's progress heartbeat
      // continues independently and another API replica can claim other jobs.
      await runWooSyncWorkerOnce(run);
    } catch {
      logger.warn({ event: "woocommerce_sync_worker_poll_failed" }, "Woo sync worker will retry");
    } finally { running = false; }
  }, POLL_MS);
  timer.unref();
}

export async function getTenantWooSyncJob(tenantId: number, id: string): Promise<Record<string, unknown> | null> {
  const result = rows<Record<string, unknown>>(await db.execute(sql`SELECT id,state,attempt_count AS "attemptCount",
    processed_parents AS "processedParents",total_parents AS "totalParents",processed_variants AS "processedVariants",
    total_variants AS "totalVariants",created_count AS created,updated_count AS updated,skipped_count AS skipped,
    failed_count AS failed,error_summary AS "errors",last_error_code AS "lastErrorCode",started_at AS "startedAt",
    completed_at AS "completedAt",created_at AS "createdAt",updated_at AS "updatedAt"
    FROM woocommerce_sync_jobs WHERE id=${id} AND tenant_id=${tenantId} LIMIT 1`));
  return result[0] ?? null;
}
