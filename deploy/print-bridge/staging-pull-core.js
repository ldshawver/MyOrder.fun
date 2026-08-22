"use strict";

function parseCupsSubmission(output) {
  const match = String(output ?? "").match(/request id is\s+(MARKLIFE_X2-(\d+))/i);
  return match ? { cupsRequestId: match[1], cupsJobId: Number(match[2]) } : null;
}

function extractCupsJobRecord(history, requestId) {
  const expected = String(requestId ?? "");
  if (!/^MARKLIFE_X2-[0-9]+$/.test(expected)) return "";
  const lines = String(history ?? "").split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith(`${expected} `) || line === expected);
  if (start < 0) return "";
  const record = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^MARKLIFE_X2-[0-9]+(?:\s|$)/.test(line)) break;
    if (!line.trim() && record.length > 1) break;
    record.push(line);
  }
  return record.join("\n").trim();
}

function classifyCupsStatus(active, completed) {
  const current = String(active ?? ""); const history = String(completed ?? "");
  if (/cancel/i.test(current) || /cancel/i.test(history)) return "canceled";
  if (/unable to send data to printer|printer-stopped|abort|failed|stopped|filter failed/i.test(current) || /unable to send data to printer|printer-stopped|abort|failed|stopped|filter failed/i.test(history)) return "cups_failed";
  if (current.trim()) return "pending";
  if (/MARKLIFE_X2-[0-9]+/.test(history)) return "completed";
  return "unknown";
}

module.exports = { parseCupsSubmission, extractCupsJobRecord, classifyCupsStatus };
