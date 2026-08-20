"use strict";

function parseCupsSubmission(output) {
  const match = String(output ?? "").match(/request id is\s+(MARKLIFE_X2-(\d+))/i);
  return match ? { cupsRequestId: match[1], cupsJobId: Number(match[2]) } : null;
}

function classifyCupsStatus(active, completed) {
  const current = String(active ?? ""); const history = String(completed ?? "");
  if (/cancel/i.test(current) || /cancel/i.test(history)) return "canceled";
  if (/abort|failed|stopped|filter failed/i.test(current) || /abort|failed|stopped|filter failed/i.test(history)) return "cups_failed";
  if (current.trim()) return "pending";
  if (/MARKLIFE_X2-[0-9]+/.test(history)) return "completed";
  return "unknown";
}

module.exports = { parseCupsSubmission, classifyCupsStatus };
