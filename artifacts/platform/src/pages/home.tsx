import { Link } from "wouter";

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans">
      <header className="px-8 py-6 flex items-center justify-between border-b border-border/50">
        <div className="font-mono font-bold text-2xl tracking-tight uppercase" data-testid="text-logo">OrderFlow</div>
        <div className="flex gap-6 items-center">
          <Link href="/sign-in" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors" data-testid="link-signin">
            Sign In
          </Link>
          <Link href="/onboarding" className="text-sm font-medium bg-foreground text-background px-5 py-2.5 rounded-sm hover:bg-foreground/90 transition-colors" data-testid="link-request-access">
            Request Access
          </Link>
        </div>
      </header>
      
      <main className="flex-1 flex flex-col items-center justify-center text-center px-4 max-w-4xl mx-auto">
        <h1 className="text-5xl md:text-7xl font-sans font-medium tracking-tight mb-8 text-foreground" data-testid="text-hero-title">
          Command your commerce.
        </h1>
        <p className="text-lg md:text-xl text-muted-foreground mb-12 max-w-2xl font-light leading-relaxed" data-testid="text-hero-subtitle">
          The backend infrastructure of serious commerce. OrderFlow is a hardened, multi-tenant B2B ordering platform for wholesale buyers, enterprise procurement teams, and their dedicated account managers.
        </p>
        
        <Link href="/onboarding" className="text-base font-medium bg-primary text-primary-foreground px-8 py-4 rounded-sm hover:opacity-90 transition-opacity shadow-sm" data-testid="link-hero-cta">
          Apply for a Tenant Account
        </Link>
      </main>
    </div>
  );
}
