import type { Config, Data } from "@measured/puck";
import { DropZone } from "@measured/puck";
import { cn } from "@/lib/utils";

export type VisualEditorData = Data;

const paletteOptions = [
  { label: "Default", value: "default" },
  { label: "Crimson", value: "crimson" },
  { label: "Slate", value: "slate" },
  { label: "Gold", value: "gold" },
] as const;

const spacingOptions = [
  { label: "Compact", value: "compact" },
  { label: "Comfortable", value: "comfortable" },
  { label: "Spacious", value: "spacious" },
] as const;

const alignOptions = [
  { label: "Left", value: "left" },
  { label: "Center", value: "center" },
  { label: "Right", value: "right" },
] as const;

function paletteClass(tone?: string) {
  switch (tone) {
    case "crimson": return "border-primary/40 bg-primary/10 text-primary";
    case "slate": return "border-slate-500/30 bg-slate-500/10 text-slate-100";
    case "gold": return "border-amber-500/30 bg-amber-500/10 text-amber-100";
    default: return "border-border bg-card text-card-foreground";
  }
}

function spacingClass(spacing?: string) {
  switch (spacing) {
    case "compact": return "p-3 gap-3";
    case "spacious": return "p-8 gap-6";
    default: return "p-5 gap-4";
  }
}

function alignClass(align?: string) {
  switch (align) {
    case "center": return "text-center items-center";
    case "right": return "text-right items-end";
    default: return "text-left items-start";
  }
}

export const defaultVisualEditorData: VisualEditorData = {
  root: { props: {} },
  content: [
    {
      type: "HeroSection",
      props: {
        eyebrow: "Self-hosted private editor",
        title: "MyOrder.fun operations workspace",
        body: "Compose internal pages from approved, safe building blocks without touching auth, payments, order routing, or permissions.",
        ctaLabel: "Preview changes",
        tone: "crimson",
      },
    },
    {
      type: "LayoutContainer",
      props: { columns: "3", spacing: "comfortable", tone: "default" },
    },
  ],
};

export const visualEditorConfig: Config = {
  categories: {
    content: {
      title: "Approved content",
      defaultExpanded: true,
      components: ["HeroSection", "HeadingBlock", "TextBlock", "EditableButton"],
    },
    operations: {
      title: "Operational displays",
      defaultExpanded: true,
      components: ["DashboardCard", "CatalogSection", "StaffPanel"],
    },
    layout: {
      title: "Layout",
      defaultExpanded: true,
      components: ["LayoutContainer"],
    },
  },
  components: {
    DashboardCard: {
      label: "Dashboard card",
      fields: {
        title: { type: "text" },
        value: { type: "text" },
        description: { type: "textarea" },
        tone: { type: "select", options: [...paletteOptions] },
      },
      defaultProps: {
        title: "Open orders",
        value: "24",
        description: "A private display card for admin dashboards.",
        tone: "default",
      },
      render: ({ title, value, description, tone }) => (
        <section className={cn("rounded-xl border shadow-sm", paletteClass(tone))}>
          <div className="p-5">
            <p className="text-sm font-medium opacity-80">{title}</p>
            <p className="mt-2 text-3xl font-bold tracking-tight">{value}</p>
            <p className="mt-2 text-sm opacity-75">{description}</p>
          </div>
        </section>
      ),
    },
    CatalogSection: {
      label: "Catalog section",
      fields: {
        title: { type: "text" },
        subtitle: { type: "textarea" },
        featuredItems: { type: "textarea" },
        tone: { type: "select", options: [...paletteOptions] },
      },
      defaultProps: {
        title: "Featured catalog area",
        subtitle: "Use this for curated product-group messaging only; product, price, inventory, and checkout logic remain outside the editor.",
        featuredItems: "New arrivals\nTop sellers\nStaff picks",
        tone: "slate",
      },
      render: ({ title, subtitle, featuredItems, tone }) => (
        <section className={cn("rounded-xl border", paletteClass(tone))}>
          <div className="p-6">
            <h3 className="text-xl font-semibold">{title}</h3>
            <p className="mt-2 text-sm opacity-75">{subtitle}</p>
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              {String(featuredItems ?? "").split("\n").filter(Boolean).slice(0, 6).map((item) => (
                <div key={item} className="rounded-lg border border-current/10 bg-background/40 px-3 py-2 text-sm">{item}</div>
              ))}
            </div>
          </div>
        </section>
      ),
    },
    HeroSection: {
      label: "Hero section",
      fields: {
        eyebrow: { type: "text" },
        title: { type: "text" },
        body: { type: "textarea" },
        ctaLabel: { type: "text" },
        align: { type: "radio", options: [...alignOptions] },
        tone: { type: "select", options: [...paletteOptions] },
      },
      defaultProps: {
        eyebrow: "Admin workspace",
        title: "Editable hero section",
        body: "Approved marketing or operations copy can be composed here while sensitive systems stay locked in code.",
        ctaLabel: "Call to action",
        align: "left",
        tone: "crimson",
      },
      render: ({ eyebrow, title, body, ctaLabel, align, tone }) => (
        <section className={cn("rounded-2xl border bg-gradient-to-br", paletteClass(tone))}>
          <div className={cn("flex min-h-64 flex-col justify-center p-8", alignClass(align))}>
            <p className="text-xs font-bold uppercase tracking-[0.3em] opacity-70">{eyebrow}</p>
            <h1 className="mt-3 max-w-3xl text-4xl font-black tracking-tight md:text-5xl">{title}</h1>
            <p className="mt-4 max-w-2xl text-base opacity-80">{body}</p>
            {ctaLabel ? <span className="mt-6 inline-flex rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground">{ctaLabel}</span> : null}
          </div>
        </section>
      ),
    },
    StaffPanel: {
      label: "Staff panel",
      fields: {
        title: { type: "text" },
        body: { type: "textarea" },
        statusLabel: { type: "text" },
        tone: { type: "select", options: [...paletteOptions] },
      },
      defaultProps: {
        title: "Staff note",
        body: "Use panels for shift instructions, internal notes, or reminders. Do not put permission or routing rules here.",
        statusLabel: "Internal only",
        tone: "gold",
      },
      render: ({ title, body, statusLabel, tone }) => (
        <aside className={cn("rounded-xl border", paletteClass(tone))}>
          <div className="p-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold">{title}</h3>
              <span className="rounded-full border border-current/20 px-2 py-1 text-xs opacity-80">{statusLabel}</span>
            </div>
            <p className="mt-3 whitespace-pre-line text-sm opacity-75">{body}</p>
          </div>
        </aside>
      ),
    },
    EditableButton: {
      label: "Button",
      fields: {
        label: { type: "text" },
        href: { type: "text" },
        variant: { type: "radio", options: [{ label: "Primary", value: "primary" }, { label: "Secondary", value: "secondary" }] },
      },
      defaultProps: { label: "Button", href: "#", variant: "primary" },
      render: ({ label, href, variant }) => (
        <a
          className={cn(
            "inline-flex rounded-md px-4 py-2 text-sm font-semibold transition-colors",
            variant === "secondary" ? "border border-border bg-card text-card-foreground" : "bg-primary text-primary-foreground",
          )}
          href={String(href || "#")}
        >
          {label}
        </a>
      ),
    },
    HeadingBlock: {
      label: "Heading",
      fields: {
        text: { type: "text" },
        level: { type: "select", options: [{ label: "H2", value: "h2" }, { label: "H3", value: "h3" }, { label: "H4", value: "h4" }] },
        align: { type: "radio", options: [...alignOptions] },
      },
      defaultProps: { text: "Editable heading", level: "h2", align: "left" },
      render: ({ text, level, align }) => {
        const className = cn("font-bold tracking-tight", align === "center" && "text-center", align === "right" && "text-right", level === "h2" ? "text-3xl" : level === "h3" ? "text-2xl" : "text-xl");
        return level === "h4" ? <h4 className={className}>{text}</h4> : level === "h3" ? <h3 className={className}>{text}</h3> : <h2 className={className}>{text}</h2>;
      },
    },
    TextBlock: {
      label: "Text block",
      fields: {
        text: { type: "textarea" },
        align: { type: "radio", options: [...alignOptions] },
      },
      defaultProps: { text: "Editable private content block.", align: "left" },
      render: ({ text, align }) => (
        <p className={cn("whitespace-pre-line text-sm leading-6 text-muted-foreground", align === "center" && "text-center", align === "right" && "text-right")}>{text}</p>
      ),
    },
    LayoutContainer: {
      label: "Layout container",
      fields: {
        columns: { type: "radio", options: [{ label: "1", value: "1" }, { label: "2", value: "2" }, { label: "3", value: "3" }] },
        spacing: { type: "select", options: [...spacingOptions] },
        tone: { type: "select", options: [...paletteOptions] },
      },
      defaultProps: { columns: "2", spacing: "comfortable", tone: "default" },
      render: ({ id, columns, spacing, tone }) => (
        <section className={cn("rounded-xl border", paletteClass(tone), spacingClass(spacing))}>
          <DropZone
            zone={`layout-${id}`}
            className={cn("grid min-h-32", columns === "3" ? "md:grid-cols-3" : columns === "2" ? "md:grid-cols-2" : "grid-cols-1", spacingClass(spacing))}
          />
        </section>
      ),
    },
  },
};
