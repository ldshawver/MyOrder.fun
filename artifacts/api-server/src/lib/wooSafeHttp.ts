import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

/** Only globally routable destinations may receive tenant WooCommerce credentials. */
export function isPublicWooAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) || (a === 192 && b === 88 && c === 99));
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.includes(".")) {
      const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
      return mapped ? isPublicWooAddress(mapped[1]) : false;
    }
    const first = Number.parseInt(normalized.split(":", 1)[0], 16);
    const second = Number.parseInt(normalized.split(":")[1] || "0", 16);
    // Documentation, Teredo and 6to4 ranges are not ordinary public origins;
    // transition ranges can also encode an otherwise prohibited IPv4 target.
    if (first === 0x2001 && (second === 0 || second === 0xdb8)) return false;
    if (first === 0x2002) return false;
    return first >= 0x2000 && first <= 0x3fff;
  }
  return false;
}

export function assertWooHttpsOrigin(input: string): URL {
  const url = new URL(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/" || !hostname || hostname === "localhost" ||
      hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
      hostname.endsWith(".internal") || (isIP(hostname) && !isPublicWooAddress(hostname))) {
    throw new Error("WooCommerce store URL must be a public HTTPS origin");
  }
  return url;
}

export async function resolvePublicWooAddress(hostname: string, resolver = lookup): Promise<{ address: string; family: 4 | 6 }> {
  const normalized = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(normalized)) {
    if (!isPublicWooAddress(normalized)) throw new Error("WooCommerce destination is prohibited");
    return { address: normalized, family: isIP(normalized) as 4 | 6 };
  }
  const addresses = await resolver(normalized, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => !isPublicWooAddress(entry.address))) {
    throw new Error("WooCommerce destination is prohibited");
  }
  return { address: addresses[0].address, family: addresses[0].family as 4 | 6 };
}

/** DNS is checked at connect time and the checked address is pinned for TLS. Redirects are rejected. */
export async function fetchWooSafely(storeUrl: string, path: string, consumerKey: string, consumerSecret: string, transport: typeof request = request): Promise<Response> {
  const origin = assertWooHttpsOrigin(storeUrl);
  const url = new URL(path, origin);
  if (url.origin !== origin.origin || !url.pathname.startsWith("/wp-json/wc/v3/")) throw new Error("Invalid WooCommerce API path");
  const authorization = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}`;
  return new Promise<Response>((resolve, reject) => {
    const req = transport(url, {
      method: "GET", timeout: TIMEOUT_MS,
      headers: { Authorization: authorization, Accept: "application/json" },
      lookup: (hostname, options, callback) => {
        resolvePublicWooAddress(hostname).then(
          result => {
            // Node's autoSelectFamily requests { all: true } and requires an
            // address record array. Returning a string there makes connect()
            // fail with ERR_INVALID_IP_ADDRESS despite valid DNS and TLS.
            if (options.all) callback(null, [result]);
            else callback(null, result.address, result.family);
          },
          error => { callback(error as Error, "", 4); },
        );
      },
    }, res => {
      const status = res.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        res.destroy();
        reject(new Error("WooCommerce redirect is prohibited"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          res.destroy();
          reject(new Error("WooCommerce response is too large"));
        } else chunks.push(chunk);
      });
      res.on("end", () => {
        const headers = new Headers({ "content-type": String(res.headers["content-type"] ?? "application/json") });
        for (const name of ["x-wp-total", "x-wp-totalpages"]) {
          const value = res.headers[name];
          if (typeof value === "string") headers.set(name, value);
        }
        resolve(new Response(Buffer.concat(chunks), { status, headers }));
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("WooCommerce request timed out")));
    req.on("error", reject);
    req.end();
  });
}
