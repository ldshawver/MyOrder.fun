export function extractApiErrorMessage(body: unknown, status: number, contentType: string): string {
  if (body && typeof body === "object" && "message" in body) {
    return String((body as { message?: unknown }).message);
  }
  if (body && typeof body === "object" && "error" in body) {
    return String((body as { error?: unknown }).error);
  }

  if (typeof body === "string") {
    const looksLikeHtml = contentType.includes("text/html") || /^\s*<!doctype html/i.test(body) || /^\s*<html/i.test(body);
    if (looksLikeHtml) {
      return `Print API unavailable (HTTP ${status}). The server returned an HTML error page instead of JSON; check the API container or Cloudflare origin status, then try again.`;
    }
    return body.length > 300 ? `${body.slice(0, 300)}…` : body;
  }

  return `HTTP ${status}`;
}
