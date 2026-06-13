import crypto from "node:crypto";

export function createSigningToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashSigningToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function buildSigningUrl(token: string, publicAppUrl = process.env.PUBLIC_APP_URL ?? process.env.APP_URL ?? "http://localhost:5173"): string {
  return `${publicAppUrl.replace(/\/$/, "")}/sign/contracts/${encodeURIComponent(token)}`;
}
