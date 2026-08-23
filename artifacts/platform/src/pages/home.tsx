import { Link } from "wouter";
import { Lock, Store, BarChart3, SlidersHorizontal } from "lucide-react";
import { PLATFORM_BRAND } from "@/lib/branding";

const capabilities = [
  { icon: Store, title: "Tenant storefronts", body: "Give each organization its own customer-facing identity while MyOrder.fun operates the platform." },
  { icon: SlidersHorizontal, title: "Configurable operations", body: "Manage catalogues, orders, users, integrations, and tenant-safe settings from one workspace." },
  { icon: BarChart3, title: "SaaS visibility", body: "Track service state and business activity without exposing another tenant's data." },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex max-w-7xl items-center justify-between border-b border-border/40 px-5 py-4 sm:px-8">
        <Link href="/" className="flex items-center gap-3" aria-label={`${PLATFORM_BRAND.displayName} home`}>
          <img src={PLATFORM_BRAND.mobileLogoUrl} alt={PLATFORM_BRAND.displayName} className="h-12 w-auto object-contain" />
          <span className="font-bold tracking-wide">{PLATFORM_BRAND.displayName}</span>
        </Link>
        <nav className="flex items-center gap-3" aria-label="Home navigation">
          <Link href="/terms-of-service" className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline">Terms</Link>
          <Link href="/privacy" className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline">Privacy</Link>
          <Link href="/sign-in" className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Sign in</Link>
        </nav>
      </header>
      <section className="mx-auto grid max-w-7xl gap-12 px-5 py-20 sm:px-8 lg:grid-cols-[1.05fr_.95fr] lg:items-center lg:py-28">
        <div>
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary"><Lock size={13} /> Tenant-aware commerce operations</div>
          <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl">Run every order with clarity.</h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">MyOrder.fun is a configurable SaaS platform for branded storefronts, order workflows, customer service, and accountable operations.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/sign-in" className="rounded-xl bg-primary px-6 py-3 font-semibold text-primary-foreground shadow-lg shadow-primary/20">Open your workspace</Link>
            <Link href="/waitlist" className="rounded-xl border border-border bg-card px-6 py-3 font-semibold">Request access</Link>
          </div>
        </div>
        <div className="rounded-3xl border border-border/50 bg-card/70 p-8 shadow-2xl">
          <img src={PLATFORM_BRAND.logoUrl} alt={`${PLATFORM_BRAND.displayName} platform logo`} className="mx-auto h-auto w-full max-w-md object-contain" />
        </div>
      </section>
      <section className="mx-auto grid max-w-7xl gap-4 px-5 pb-20 sm:px-8 md:grid-cols-3">
        {capabilities.map(({ icon: Icon, title, body }) => <article key={title} className="rounded-2xl border border-border/50 bg-card p-6"><Icon className="text-primary" size={22} /><h2 className="mt-4 font-semibold">{title}</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p></article>)}
      </section>
    </main>
  );
}
