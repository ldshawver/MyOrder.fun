import { runFeedbackAutoArchive } from "../routes/feedback";
import { logger } from "./logger";

const DEFAULT_ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_ARCHIVE_INTERVAL_MS = 60 * 60 * 1000;

let feedbackArchiveTimer: NodeJS.Timeout | null = null;

function configuredIntervalMs(): number {
  const raw = process.env["FEEDBACK_ARCHIVE_INTERVAL_MS"];
  if (!raw) return DEFAULT_ARCHIVE_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_ARCHIVE_INTERVAL_MS) {
    logger.warn({ raw }, "Invalid FEEDBACK_ARCHIVE_INTERVAL_MS; using default feedback archive interval");
    return DEFAULT_ARCHIVE_INTERVAL_MS;
  }
  return parsed;
}

export async function runScheduledFeedbackArchive(): Promise<void> {
  try {
    const result = await runFeedbackAutoArchive(null);
    logger.info(result, "Scheduled feedback archive policy completed");
  } catch (err) {
    logger.error({ err }, "Scheduled feedback archive policy failed");
  }
}

export function startFeedbackArchiveScheduler(): void {
  if (feedbackArchiveTimer) return;

  const intervalMs = configuredIntervalMs();
  feedbackArchiveTimer = setInterval(() => {
    void runScheduledFeedbackArchive();
  }, intervalMs);
  feedbackArchiveTimer.unref?.();

  setTimeout(() => {
    void runScheduledFeedbackArchive();
  }, 30_000).unref?.();

  logger.info({ intervalMs }, "Scheduled feedback archive policy started");
}

export function stopFeedbackArchiveSchedulerForTests(): void {
  if (!feedbackArchiveTimer) return;
  clearInterval(feedbackArchiveTimer);
  feedbackArchiveTimer = null;
}
