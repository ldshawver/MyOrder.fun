import type { Config, Data } from "@measured/puck";
import { cn } from "@/lib/utils";

export type WebPageData = Data;

const alignOptions = [
  { label: "Left", value: "left" },
  { label: "Center", value: "center" },
  { label: "Right", value: "right" },
] as const;

const colorOptions = [
  { label: "Dark", value: "dark" },
  { label: "Light", value: "light" },
  { label: "Crimson", value: "crimson" },
  { label: "Slate", value: "slate" },
] as const;

function bgClass(color?: string) {
  switch (color) {
    case "light": return "bg-white text-gray-900";
    case "crimson": return "bg-red-900 text-white";
    case "slate": return "bg-slate-800 text-white";
    default: return "bg-black text-white";
  }
}

function alignClass(align?: string) {
  switch (align) {
    case "center": return "text-center items-center mx-auto";
    case "right": return "text-right items-end ml-auto";
    default: return "text-left items-start";
  }
}

export const defaultWebPageData: WebPageData = {
  root: { props: {} },
  content: [
    {
      type: "Hero",
      props: {
        eyebrow: "Welcome",
        title: "Marketing page title",
        subtitle: "Edit this page using the visual editor. Add sections from the left panel.",
        ctaLabel: "Shop Now",
        ctaHref: "/catalog",
        color: "dark",
        align: "center",
      },
    },
    {
      type: "TextBlock",
      props: {
        content: "Add your marketing copy here. This block supports multi-line text for rich descriptions, product copy, and brand messaging.",
        align: "center",
        size: "base",
      },
    },
  ],
};

export const webEditorConfig: Config = {
  categories: {
    hero: {
      title: "Hero & Banners",
      defaultExpanded: true,
      components: ["Hero", "ImageBanner", "PromoBanner"],
    },
    content: {
      title: "Content",
      defaultExpanded: true,
      components: ["TextBlock", "FAQ"],
    },
    action: {
      title: "Actions",
      defaultExpanded: true,
      components: ["CTA"],
    },
  },
  components: {
    Hero: {
      label: "Hero",
      fields: {
        eyebrow: { type: "text" },
        title: { type: "text" },
        subtitle: { type: "textarea" },
        ctaLabel: { type: "text" },
        ctaHref: { type: "text" },
        color: { type: "select", options: [...colorOptions] },
        align: { type: "radio", options: [...alignOptions] },
      },
      defaultProps: {
        eyebrow: "Discover",
        title: "Hero heading",
        subtitle: "Supporting text goes here.",
        ctaLabel: "Shop Now",
        ctaHref: "/catalog",
        color: "dark",
        align: "center",
      },
      render: ({ eyebrow, title, subtitle, ctaLabel, ctaHref, color, align }) => (
        <section className={cn("w-full py-20 px-6", bgClass(color))}>
          <div className={cn("max-w-4xl flex flex-col gap-5", alignClass(align))}>
            {eyebrow ? (
              <p className="text-xs font-bold uppercase tracking-[0.3em] opacity-60">{eyebrow}</p>
            ) : null}
            <h1 className="text-4xl font-black tracking-tight md:text-6xl">{title}</h1>
            {subtitle ? <p className="max-w-2xl text-lg opacity-75">{subtitle}</p> : null}
            {ctaLabel ? (
              <a
                href={String(ctaHref || "#")}
                className="mt-2 inline-flex w-fit rounded-full bg-red-700 px-8 py-3 text-sm font-bold text-white uppercase tracking-wide hover:bg-red-600 transition-colors"
              >
                {ctaLabel}
              </a>
            ) : null}
          </div>
        </section>
      ),
    },

    TextBlock: {
      label: "Text Block",
      fields: {
        content: { type: "textarea" },
        align: { type: "radio", options: [...alignOptions] },
        size: {
          type: "select",
          options: [
            { label: "Small", value: "sm" },
            { label: "Base", value: "base" },
            { label: "Large", value: "lg" },
          ],
        },
      },
      defaultProps: {
        content: "Enter your text here.",
        align: "left",
        size: "base",
      },
      render: ({ content, align, size }) => (
        <div className={cn("w-full max-w-3xl px-6 py-8", alignClass(align), align === "center" && "mx-auto")}>
          <p
            className={cn(
              "whitespace-pre-line leading-relaxed text-muted-foreground",
              size === "sm" ? "text-sm" : size === "lg" ? "text-lg" : "text-base",
            )}
          >
            {content}
          </p>
        </div>
      ),
    },

    ImageBanner: {
      label: "Image Banner",
      fields: {
        imageUrl: { type: "text" },
        alt: { type: "text" },
        caption: { type: "text" },
        height: {
          type: "select",
          options: [
            { label: "Short (200px)", value: "200" },
            { label: "Medium (360px)", value: "360" },
            { label: "Tall (480px)", value: "480" },
          ],
        },
      },
      defaultProps: {
        imageUrl: "https://images.unsplash.com/photo-1512436991641-6745cdb1723f?w=1200&q=80",
        alt: "Banner image",
        caption: "",
        height: "360",
      },
      render: ({ imageUrl, alt, caption, height }) => (
        <figure className="w-full overflow-hidden">
          <img
            src={String(imageUrl || "")}
            alt={String(alt || "")}
            className="w-full object-cover"
            style={{ height: `${height}px` }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          {caption ? (
            <figcaption className="py-2 text-center text-xs text-muted-foreground">{caption}</figcaption>
          ) : null}
        </figure>
      ),
    },

    PromoBanner: {
      label: "Promo Banner",
      fields: {
        badge: { type: "text" },
        headline: { type: "text" },
        body: { type: "textarea" },
        color: { type: "select", options: [...colorOptions] },
        align: { type: "radio", options: [...alignOptions] },
      },
      defaultProps: {
        badge: "Limited Time",
        headline: "Promo announcement",
        body: "Describe your offer or announcement here.",
        color: "crimson",
        align: "center",
      },
      render: ({ badge, headline, body, color, align }) => (
        <section className={cn("w-full py-10 px-6", bgClass(color))}>
          <div className={cn("max-w-3xl flex flex-col gap-3", alignClass(align))}>
            {badge ? (
              <span className="w-fit rounded-full border border-current/30 px-3 py-1 text-xs font-bold uppercase tracking-widest opacity-80">
                {badge}
              </span>
            ) : null}
            <h2 className="text-3xl font-black tracking-tight">{headline}</h2>
            {body ? <p className="max-w-xl opacity-75">{body}</p> : null}
          </div>
        </section>
      ),
    },

    CTA: {
      label: "Call to Action",
      fields: {
        heading: { type: "text" },
        body: { type: "textarea" },
        primaryLabel: { type: "text" },
        primaryHref: { type: "text" },
        secondaryLabel: { type: "text" },
        secondaryHref: { type: "text" },
        color: { type: "select", options: [...colorOptions] },
      },
      defaultProps: {
        heading: "Ready to shop?",
        body: "Browse our full catalog and place a discreet order today.",
        primaryLabel: "Browse Catalog",
        primaryHref: "/catalog",
        secondaryLabel: "Learn More",
        secondaryHref: "#",
        color: "dark",
      },
      render: ({ heading, body, primaryLabel, primaryHref, secondaryLabel, secondaryHref, color }) => (
        <section className={cn("w-full py-16 px-6 text-center", bgClass(color))}>
          <div className="mx-auto max-w-2xl flex flex-col items-center gap-5">
            <h2 className="text-3xl font-black tracking-tight">{heading}</h2>
            {body ? <p className="opacity-75">{body}</p> : null}
            <div className="flex flex-wrap justify-center gap-3">
              {primaryLabel ? (
                <a
                  href={String(primaryHref || "#")}
                  className="rounded-full bg-red-700 px-7 py-3 text-sm font-bold uppercase tracking-wide text-white hover:bg-red-600 transition-colors"
                >
                  {primaryLabel}
                </a>
              ) : null}
              {secondaryLabel ? (
                <a
                  href={String(secondaryHref || "#")}
                  className="rounded-full border border-current/30 px-7 py-3 text-sm font-semibold uppercase tracking-wide hover:border-current/60 transition-colors"
                >
                  {secondaryLabel}
                </a>
              ) : null}
            </div>
          </div>
        </section>
      ),
    },

    FAQ: {
      label: "FAQ",
      fields: {
        heading: { type: "text" },
        items: { type: "textarea" },
      },
      defaultProps: {
        heading: "Frequently Asked Questions",
        items: "Is shipping discreet?\nYes — all orders ship in plain, unmarked packaging with no brand name on the label.\n\nHow do I track my order?\nYou'll receive a tracking link via the email used at checkout.",
      },
      render: ({ heading, items }) => {
        const pairs: Array<{ q: string; a: string }> = [];
        const lines = String(items || "").split("\n").map(l => l.trim()).filter(Boolean);
        for (let i = 0; i < lines.length; i += 2) {
          if (lines[i] && lines[i + 1]) {
            pairs.push({ q: lines[i], a: lines[i + 1] });
          }
        }
        return (
          <section className="w-full max-w-3xl mx-auto px-6 py-12">
            {heading ? <h2 className="mb-8 text-2xl font-black tracking-tight">{heading}</h2> : null}
            <div className="divide-y divide-border">
              {pairs.map(({ q, a }) => (
                <details key={q} className="group py-4">
                  <summary className="flex cursor-pointer items-center justify-between gap-4 font-semibold list-none">
                    <span>{q}</span>
                    <span className="text-muted-foreground text-lg group-open:rotate-45 transition-transform">+</span>
                  </summary>
                  <p className="mt-3 text-sm text-muted-foreground leading-relaxed">{a}</p>
                </details>
              ))}
            </div>
            {pairs.length === 0 && (
              <p className="text-sm text-muted-foreground italic">Enter Q&A pairs separated by line breaks: one question, one answer, repeat.</p>
            )}
          </section>
        );
      },
    },
  },
};
