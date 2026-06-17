import type { Config, Data } from "@measured/puck";
import { cn } from "@/lib/utils";

export type VisualEditorData = Data;

const alignOptions = [{ label: "Left", value: "left" }, { label: "Center", value: "center" }, { label: "Right", value: "right" }] as const;
const toneOptions = [{ label: "Default", value: "default" }, { label: "Crimson", value: "crimson" }, { label: "Gold", value: "gold" }] as const;
const layoutOptions = [{ label: "Grid", value: "grid" }, { label: "Carousel", value: "carousel" }, { label: "Stack", value: "stack" }] as const;

function toneClass(tone?: string) { return tone === "crimson" ? "border-primary/40 bg-primary/10" : tone === "gold" ? "border-amber-500/30 bg-amber-500/10" : "border-border bg-card"; }
function alignClass(align?: string) { return align === "center" ? "text-center items-center" : align === "right" ? "text-right items-end" : "text-left items-start"; }
function safeHref(href?: unknown) { const value = String(href || "#").trim(); return /^(https?:\/\/|\/|#|mailto:|tel:)/i.test(value) ? value : "#"; }
function lines(value?: unknown) { return String(value ?? "").split("\n").map((x) => x.trim()).filter(Boolean); }

export const defaultVisualEditorData: VisualEditorData = {
  root: { props: {} },
  content: [{ type: "HeroSection", props: { eyebrow: "MyOrder.fun", title: "Published content page", body: "Edit safe customer-facing content without changing inventory, orders, checkout, pricing, taxes, payments, or permissions.", ctaLabel: "Shop catalog", ctaHref: "/catalog", tone: "crimson", align: "left" } }],
};

export const visualEditorConfig: Config = {
  categories: {
<<<<<<< HEAD
    content: { title: "Safe content", defaultExpanded: true, components: ["HeroSection", "TextBlock", "ImageBlock", "CTAButton", "FAQBlock", "FeatureGrid", "AnnouncementBanner", "ContactInfoBlock", "StoreHoursBlock", "SafeHtmlBlock"] },
=======
    content: { title: "Safe content", defaultExpanded: true, components: ["HeroSection", "TextBlock", "ImageBlock", "CTAButton", "FAQBlock", "FeatureGrid", "AnnouncementBanner", "ContactInfoBlock", "StoreHoursBlock"] },
>>>>>>> e99c0cb (Checkpoint local branch changes before refresh)
    catalog: { title: "Catalog presentation", defaultExpanded: true, components: ["CatalogSection", "FeaturedProductsBlock", "ProductPromoGrid"] },
  },
  components: {
    HeroSection: { label: "Hero section", fields: { eyebrow: { type: "text" }, title: { type: "text" }, body: { type: "textarea" }, ctaLabel: { type: "text" }, ctaHref: { type: "text" }, align: { type: "radio", options: [...alignOptions] }, tone: { type: "select", options: [...toneOptions] } }, defaultProps: { eyebrow: "Featured", title: "Safe page headline", body: "Add approved customer-facing copy.", ctaLabel: "Learn more", ctaHref: "#", align: "left", tone: "default" }, render: ({ eyebrow, title, body, ctaLabel, ctaHref, align, tone }) => <section className={cn("rounded-2xl border p-8", toneClass(tone), alignClass(align))}><p className="text-xs font-bold uppercase tracking-[0.3em] text-primary">{eyebrow}</p><h1 className="mt-3 text-4xl font-black tracking-tight">{title}</h1><p className="mt-4 max-w-2xl whitespace-pre-line text-muted-foreground">{body}</p>{ctaLabel ? <a className="mt-6 inline-flex rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground" href={safeHref(ctaHref)}>{ctaLabel}</a> : null}</section> },
    TextBlock: { label: "Text block", fields: { text: { type: "textarea" }, align: { type: "radio", options: [...alignOptions] } }, defaultProps: { text: "Editable safe content.", align: "left" }, render: ({ text, align }) => <p className={cn("whitespace-pre-line leading-7 text-muted-foreground", alignClass(align))}>{text}</p> },
    ImageBlock: { label: "Image", fields: { src: { type: "text" }, alt: { type: "text" }, caption: { type: "text" } }, defaultProps: { src: "/alavont-logo-glow.png", alt: "Featured image", caption: "" }, render: ({ src, alt, caption }) => <figure className="overflow-hidden rounded-xl border bg-card"><img className="max-h-96 w-full object-cover" src={String(src || "/alavont-logo-glow.png")} alt={String(alt || "")} /><figcaption className="p-3 text-sm text-muted-foreground">{caption}</figcaption></figure> },
    CTAButton: { label: "CTA button", fields: { label: { type: "text" }, href: { type: "text" }, variant: { type: "radio", options: [{ label: "Primary", value: "primary" }, { label: "Secondary", value: "secondary" }] } }, defaultProps: { label: "Call to action", href: "#", variant: "primary" }, render: ({ label, href, variant }) => <a href={safeHref(href)} className={cn("inline-flex rounded-md px-4 py-2 text-sm font-semibold", variant === "secondary" ? "border bg-card" : "bg-primary text-primary-foreground")}>{label}</a> },
    ProductPromoGrid: { label: "Product promo grid", fields: { title: { type: "text" }, items: { type: "textarea" }, layout: { type: "select", options: [...layoutOptions] } }, defaultProps: { title: "Promotions", items: "Featured item\nNew arrival\nStaff pick", layout: "grid" }, render: ({ title, items, layout }) => <section><h2 className="text-2xl font-bold">{title}</h2><div className={cn("mt-4 gap-3", layout === "stack" ? "grid" : "grid md:grid-cols-3")}>{lines(items).slice(0, 9).map((item) => <div key={item} className="rounded-lg border bg-card p-4">{item}</div>)}</div></section> },
    FAQBlock: { label: "FAQ", fields: { title: { type: "text" }, faqs: { type: "textarea" } }, defaultProps: { title: "FAQ", faqs: "Question?\nAnswer." }, render: ({ title, faqs }) => <section><h2 className="text-2xl font-bold">{title}</h2><div className="mt-4 space-y-3">{lines(faqs).map((line) => <p key={line} className="rounded-lg border p-3 text-sm">{line}</p>)}</div></section> },
    FeatureGrid: { label: "Feature grid", fields: { title: { type: "text" }, features: { type: "textarea" } }, defaultProps: { title: "Features", features: "Secure checkout\nDiscreet service\nFast pickup" }, render: ({ title, features }) => <section><h2 className="text-2xl font-bold">{title}</h2><div className="mt-4 grid gap-3 md:grid-cols-3">{lines(features).slice(0, 6).map((f) => <div key={f} className="rounded-lg border bg-card p-4">{f}</div>)}</div></section> },
    AnnouncementBanner: { label: "Announcement", fields: { message: { type: "textarea" }, tone: { type: "select", options: [...toneOptions] } }, defaultProps: { message: "Announcement text", tone: "crimson" }, render: ({ message, tone }) => <aside className={cn("rounded-xl border p-4 font-medium", toneClass(tone))}>{message}</aside> },
    ContactInfoBlock: { label: "Contact info", fields: { title: { type: "text" }, phone: { type: "text" }, email: { type: "text" }, address: { type: "textarea" } }, defaultProps: { title: "Contact us", phone: "", email: "", address: "" }, render: ({ title, phone, email, address }) => <section className="rounded-xl border bg-card p-5"><h2 className="font-bold">{title}</h2><p>{phone}</p><p>{email}</p><p className="whitespace-pre-line text-muted-foreground">{address}</p></section> },
    StoreHoursBlock: { label: "Store hours", fields: { title: { type: "text" }, hours: { type: "textarea" } }, defaultProps: { title: "Hours", hours: "Monday-Friday: 9am-5pm" }, render: ({ title, hours }) => <section className="rounded-xl border bg-card p-5"><h2 className="font-bold">{title}</h2><p className="whitespace-pre-line text-muted-foreground">{hours}</p></section> },
    CatalogSection: { label: "Catalog section", fields: { title: { type: "text" }, description: { type: "textarea" }, layout: { type: "select", options: [...layoutOptions] }, quantityLabel: { type: "text" } }, defaultProps: { title: "Catalog section", description: "Presentation-only catalog copy.", layout: "grid", quantityLabel: "Available" }, render: ({ title, description, layout, quantityLabel }) => <section className="rounded-xl border bg-card p-5"><div className="flex justify-between gap-3"><div><h2 className="text-2xl font-bold">{title}</h2><p className="mt-2 text-muted-foreground">{description}</p></div><span className="text-xs uppercase text-primary">{layout}</span></div><p className="mt-4 text-sm">Quantity label: {quantityLabel}</p></section> },
<<<<<<< HEAD
    SafeHtmlBlock: { label: "Sanitized HTML fallback", fields: { sanitizedHtml: { type: "textarea" } }, defaultProps: { sanitizedHtml: "" }, render: ({ sanitizedHtml }) => <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground whitespace-pre-wrap">{String(sanitizedHtml ?? "").replace(/<[^>]+>/g, " ")}</div> },
=======
>>>>>>> e99c0cb (Checkpoint local branch changes before refresh)
    FeaturedProductsBlock: { label: "Featured products", fields: { title: { type: "text" }, productNames: { type: "textarea" } }, defaultProps: { title: "Featured products", productNames: "Product one\nProduct two" }, render: ({ title, productNames }) => <section><h2 className="text-2xl font-bold">{title}</h2><div className="mt-4 grid gap-3 md:grid-cols-2">{lines(productNames).slice(0, 8).map((name) => <div key={name} className="rounded-lg border p-4">{name}</div>)}</div></section> },
  },
};
