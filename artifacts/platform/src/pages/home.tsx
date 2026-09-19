import { Link } from "wouter";
import { Lock, Store, BarChart3, SlidersHorizontal } from "lucide-react";
import { useBrand } from "@/contexts/BrandContext";

export default function Home() {
  const { branding, publicBrandLoading } = useBrand();
  const name = branding.customer.displayName;
  const description = branding.customer.businessDescription;
  if (publicBrandLoading) {
    return <main className="min-h-screen bg-background text-foreground flex items-center justify-center"><span className="text-sm text-muted-foreground">Loading storefront…</span></main>;
  }
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex max-w-7xl items-center justify-between border-b border-border/40 px-5 py-4 sm:px-8">
        <Link href="/" className="flex items-center gap-3" aria-label={`${name} home`}>
          <img src={branding.customer.logoUrl} alt={name} className="h-12 w-auto object-contain" />
          <span className="font-bold tracking-wide">{name}</span>
        </Link>
        <nav className="flex items-center gap-3" aria-label="Home navigation">
          <Link href="/terms-of-service" className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline">Terms</Link>
          <Link href="/privacy" className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline">Privacy</Link>
          <Link href="/sign-in" className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Sign in</Link>
        </nav>
      </header>
      <section className="mx-auto grid max-w-7xl gap-12 px-5 py-20 sm:px-8 lg:grid-cols-[1.05fr_.95fr] lg:items-center lg:py-28">
        <div>
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary"><Lock size={13} /> Private shopping</div>
          <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl">{name}</h1>
          {description && <p className="mt-6 max-w-2xl whitespace-pre-line text-lg leading-relaxed text-muted-foreground">{description}</p>}
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/sign-in" className="rounded-xl bg-primary px-6 py-3 font-semibold text-primary-foreground shadow-lg shadow-primary/20">Sign in</Link>
            <Link href="/sign-up" className="rounded-xl border border-border bg-card px-6 py-3 font-semibold">Create account</Link>
          </div>
        </div>
        <div className="rounded-3xl border border-border/50 bg-card/70 p-8 shadow-2xl">
          <img src={branding.customer.logoUrl} alt={name} className="mx-auto h-auto w-full max-w-md object-contain" />
        </div>
      </section>
      <section className="mx-auto grid max-w-7xl gap-4 px-5 pb-20 sm:px-8 md:grid-cols-3">
        {[
          { icon: Store, title: "Discreet shopping", body: "Browse and order with privacy in mind." },
          { icon: SlidersHorizontal, title: "Curated selection", body: "Explore products selected for your experience." },
          { icon: BarChart3, title: "Simple checkout", body: "Review your order and checkout securely." },
        ].map(({ icon: Icon, title, body }) => <article key={title} className="rounded-2xl border border-border/50 bg-card p-6"><Icon className="text-primary" size={22} /><h2 className="mt-4 font-semibold">{title}</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p></article>)}
      </section>
    </main>
  );
}
