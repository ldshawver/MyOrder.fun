const MAX_IMPORT_HTML_BYTES = 200_000;
const UNSAFE_TAG_RE = /<\/?\s*(script|iframe|object|embed|base|form|input|button|textarea|select|option|link|meta|style)\b[^>]*>/gi;
const EVENT_ATTR_RE = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const UNSAFE_ATTR_RE = /\s+(srcdoc|style)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URL_RE = /(href|src)\s*=\s*(["'])\s*(?:javascript:|vbscript:|data:text\/html)/gi;

export type PuckImportBlock = { type: string; props: Record<string, unknown> };
export type PuckImportData = { root: { props: Record<string, unknown> }; content: PuckImportBlock[] };

function decodeEntities(value: string): string {
  return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
}

function textOnly(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return decodeEntities(match?.[2] ?? match?.[3] ?? match?.[4] ?? "").trim() || undefined;
}

export function isSafeInternalPath(path: string): boolean {
  const value = path.trim();
  return value.startsWith("/") && !value.startsWith("//") && !/[\\\u0000-\u001f]/.test(value) && !/^\/(?:api|admin)(?:\/|$)/i.test(value);
}

export function sanitizeImportedHtml(input: string): string {
  if (Buffer.byteLength(input, "utf8") > MAX_IMPORT_HTML_BYTES) throw Object.assign(new Error("Imported HTML is too large"), { status: 413 });
  return input
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(UNSAFE_TAG_RE, "")
    .replace(EVENT_ATTR_RE, "")
    .replace(UNSAFE_ATTR_RE, "")
    .replace(JS_URL_RE, '$1="#')
    .replace(/\s+/g, " ")
    .trim();
}

function safeLink(value?: string): string {
  const href = (value ?? "#").trim();
  if (/^(?:javascript:|vbscript:|data:text\/html)/i.test(href)) return "#";
  return /^(https?:\/\/|\/|#|mailto:|tel:)/i.test(href) ? href : "#";
}

export function importPageToPuck(html: string, fallbackTitle = "Imported page"): PuckImportData {
  const sanitizedHtml = sanitizeImportedHtml(html);
  const content: PuckImportBlock[] = [];
  const title = textOnly(sanitizedHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? fallbackTitle);
  const firstParagraph = textOnly(sanitizedHtml.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");
  const firstLinkTag = sanitizedHtml.match(/<a\b[^>]*>[\s\S]*?<\/a>/i)?.[0] ?? "";
  const ctaLabel = textOnly(firstLinkTag);
  content.push({ type: "HeroSection", props: { eyebrow: "Imported page", title: title || fallbackTitle, body: firstParagraph, ctaLabel, ctaHref: safeLink(attr(firstLinkTag, "href")), align: "left", tone: "default" } });

  for (const match of sanitizedHtml.matchAll(/<(h2|h3|p|img|a)\b([^>]*)>([\s\S]*?)<\/\1>|<img\b([^>]*)\/?>/gi)) {
    const tag = (match[1] ?? "img").toLowerCase();
    const attrs = match[2] ?? match[4] ?? "";
    const body = match[3] ?? "";
    if (tag === "h2" || tag === "h3") content.push({ type: "TextBlock", props: { text: textOnly(body), align: "left" } });
    if (tag === "p") { const text = textOnly(body); if (text && text !== firstParagraph) content.push({ type: "TextBlock", props: { text, align: "left" } }); }
    if (tag === "img") content.push({ type: "ImageBlock", props: { src: safeLink(attr(attrs, "src")), alt: attr(attrs, "alt") ?? "Imported image", caption: "" } });
    if (tag === "a") { const label = textOnly(body); if (label && label !== ctaLabel) content.push({ type: "CTAButton", props: { label, href: safeLink(attr(attrs, "href")), variant: "secondary" } }); }
    if (content.length >= 80) break;
  }
  const usedText = content.map((b) => Object.values(b.props).join(" ")).join(" ");
  const remaining = textOnly(sanitizedHtml);
  if (remaining && !usedText.includes(remaining.slice(0, 80))) content.push({ type: "SafeHtmlBlock", props: { sanitizedHtml: sanitizedHtml.slice(0, 20_000) } });
  return { root: { props: {} }, content };
}
