import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { UserProfile } from "@workspace/api-client-react";
import { useClerk } from "@clerk/react";
import { 
  LayoutDashboard, 
  FlaskConical, 
  ShoppingCart, 
  MessageSquare, 
  ShieldAlert, 
  LogOut,
  Bell,
  Users,
  User,
  ListTodo,
  Menu,
  X,
  ChevronRight,
  Printer
} from "lucide-react";
import { usePushNotifications } from "@/hooks/usePushNotifications";

export default function Layout({ children, user }: { children: ReactNode, user: UserProfile }) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  usePushNotifications({ role: user.role as "customer" | "staff" | "tenant_admin" | "global_admin" });

  const navItems = [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["tenant_admin", "staff", "customer", "global_admin"], mobileShow: true },
    { href: "/catalog", label: "Catalog", icon: FlaskConical, roles: ["tenant_admin", "staff", "customer", "global_admin"], mobileShow: true },
    { href: "/orders", label: "Orders", icon: ShoppingCart, roles: ["tenant_admin", "staff", "customer", "global_admin"], mobileShow: true },
    { href: "/ai-concierge", label: "Concierge", icon: MessageSquare, roles: ["tenant_admin", "staff", "customer", "global_admin"], mobileShow: true },
    { href: "/staff", label: "Sitter Queue", icon: ListTodo, roles: ["tenant_admin", "staff", "global_admin"], mobileShow: false },
    { href: "/admin/users", label: "Users", icon: Users, roles: ["tenant_admin", "global_admin"], mobileShow: false },
    { href: "/admin/print", label: "Print", icon: Printer, roles: ["tenant_admin", "global_admin"], mobileShow: false },
    { href: "/global-admin", label: "Platform Admin", icon: ShieldAlert, roles: ["global_admin"], mobileShow: false },
  ];

  const visibleNavItems = navItems.filter(item => item.roles.includes(user.role));
  const mobileNavItems = visibleNavItems.filter(item => item.mobileShow);

  function isActive(href: string) {
    return location === href || (location.startsWith(href + "/") && href !== "/dashboard" && href !== "/global-admin");
  }

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex font-sans">

      {/* ── Desktop Sidebar ──────────────────────────────────────────── */}
      <aside className="w-64 border-r border-border/50 bg-sidebar flex-col hidden md:flex shrink-0">
        {/* Logo */}
        <div className="p-5 border-b border-border/40">
          <Link href="/dashboard" className="flex items-center gap-3 group">
            <img
              src="/alavont-logo.png"
              alt="Alavont"
              className="w-9 h-9 object-contain group-hover:scale-105 transition-transform"
            />
            <div>
              <div className="font-bold text-sm tracking-wide text-foreground" data-testid="text-sidebar-logo">
                ALAVONT
              </div>
              <div className="text-[10px] text-primary/80 font-medium tracking-widest uppercase">
                Therapeutics
              </div>
            </div>
          </Link>
          {user.tenantName && (
            <div className="mt-3 px-1">
              <div className="text-[10px] text-muted-foreground uppercase tracking-widest font-medium">Organization</div>
              <div className="text-sm font-medium truncate mt-0.5" data-testid="text-sidebar-tenant">{user.tenantName}</div>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          <div className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-widest mb-2 px-3 pt-2">Navigation</div>
          {visibleNavItems.map((item) => {
            const active = isActive(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm group relative ${
                  active
                    ? "bg-primary/15 text-primary font-semibold"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-foreground"
                }`}
                data-testid={`link-nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
              >
                {active && (
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-r-full" />
                )}
                <Icon size={16} className={active ? "text-primary" : "text-muted-foreground group-hover:text-foreground"} />
                <span>{item.label}</span>
                {active && <ChevronRight size={14} className="ml-auto text-primary/60" />}
              </Link>
            );
          })}
        </nav>

        {/* User footer */}
        <div className="p-3 border-t border-border/40 space-y-1">
          <Link
            href="/notifications"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground transition-all"
            data-testid="link-notifications"
          >
            <Bell size={16} />
            <span>Notifications</span>
          </Link>
          <Link
            href="/account"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all group"
            data-testid="link-account"
          >
            <div className="w-8 h-8 rounded-full bg-primary/20 text-primary flex items-center justify-center shrink-0 border border-primary/30">
              <User size={14} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate" data-testid="text-user-name">
                {user.firstName || "User"} {user.lastName}
              </div>
              <div className="text-[10px] text-muted-foreground capitalize font-medium" data-testid="text-user-role">
                {user.role.replace(/_/g, " ")}
              </div>
            </div>
          </Link>
          <button
            onClick={() => signOut()}
            className="flex items-center gap-3 px-3 py-2.5 w-full text-left text-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive rounded-lg transition-all"
            data-testid="button-sign-out"
          >
            <LogOut size={16} />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* ── Mobile Slide-over Menu ───────────────────────────────────── */}
      {mobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative w-72 bg-sidebar border-r border-border/50 flex flex-col h-full shadow-2xl">
            <div className="p-5 border-b border-border/40 flex items-center justify-between">
              <Link href="/dashboard" className="flex items-center gap-3" onClick={() => setMobileMenuOpen(false)}>
                <img src="/alavont-logo.png" alt="Alavont" className="w-8 h-8 object-contain" />
                <div>
                  <div className="font-bold text-sm tracking-wide">ALAVONT</div>
                  <div className="text-[10px] text-primary/80 tracking-widest uppercase">Therapeutics</div>
                </div>
              </Link>
              <button onClick={() => setMobileMenuOpen(false)} className="text-muted-foreground hover:text-foreground p-1">
                <X size={20} />
              </button>
            </div>

            {user.tenantName && (
              <div className="px-5 py-3 bg-primary/5 border-b border-border/30">
                <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Organization</div>
                <div className="text-sm font-medium mt-0.5">{user.tenantName}</div>
              </div>
            )}

            <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
              {visibleNavItems.map((item) => {
                const active = isActive(item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-sm ${
                      active
                        ? "bg-primary/15 text-primary font-semibold"
                        : "text-foreground/70 hover:bg-sidebar-accent/60"
                    }`}
                  >
                    <Icon size={18} className={active ? "text-primary" : "text-muted-foreground"} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>

            <div className="p-3 border-t border-border/40 space-y-1">
              <Link
                href="/account"
                onClick={() => setMobileMenuOpen(false)}
                className="flex items-center gap-3 px-4 py-3 rounded-xl"
              >
                <div className="w-9 h-9 rounded-full bg-primary/20 flex items-center justify-center border border-primary/30">
                  <User size={15} />
                </div>
                <div>
                  <div className="text-sm font-medium">{user.firstName || "User"} {user.lastName}</div>
                  <div className="text-[10px] text-muted-foreground capitalize">{user.role.replace(/_/g, " ")}</div>
                </div>
              </Link>
              <button
                onClick={() => signOut()}
                className="flex items-center gap-3 px-4 py-3 w-full text-left text-sm text-muted-foreground hover:text-destructive rounded-xl transition-colors"
              >
                <LogOut size={16} />
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Main Content Area ────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col h-[100dvh] overflow-hidden bg-background min-w-0">

        {/* Mobile top bar */}
        <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-border/40 bg-sidebar/80 backdrop-blur shrink-0">
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="text-muted-foreground hover:text-foreground p-1.5 rounded-lg hover:bg-sidebar-accent/60 transition-colors"
          >
            <Menu size={22} />
          </button>
          <Link href="/dashboard" className="flex items-center gap-2">
            <img src="/alavont-logo.png" alt="Alavont" className="w-7 h-7 object-contain" />
            <span className="font-bold text-sm tracking-wide">ALAVONT</span>
          </Link>
          <Link href="/notifications" className="text-muted-foreground hover:text-foreground p-1.5 rounded-lg hover:bg-sidebar-accent/60 transition-colors">
            <Bell size={20} />
          </Link>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          <div className="p-4 md:p-8 max-w-7xl mx-auto pb-24 md:pb-8">
            {children}
          </div>
        </main>

        {/* ── Mobile Bottom Tab Bar ────────────────────────────────── */}
        <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-sidebar/95 backdrop-blur-xl border-t border-border/50 bottom-nav-safe z-40">
          <div className="flex items-center justify-around px-2 py-2">
            {mobileNavItems.map((item) => {
              const active = isActive(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl transition-all min-w-[56px] ${
                    active ? "text-primary" : "text-muted-foreground"
                  }`}
                >
                  <div className={`p-1.5 rounded-lg transition-colors ${active ? "bg-primary/15" : ""}`}>
                    <Icon size={20} strokeWidth={active ? 2.5 : 1.8} />
                  </div>
                  <span className="text-[10px] font-medium">{item.label}</span>
                </Link>
              );
            })}
            <Link
              href="/account"
              className={`flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl transition-all min-w-[56px] ${
                isActive("/account") ? "text-primary" : "text-muted-foreground"
              }`}
            >
              <div className={`p-1.5 rounded-lg transition-colors ${isActive("/account") ? "bg-primary/15" : ""}`}>
                <User size={20} strokeWidth={isActive("/account") ? 2.5 : 1.8} />
              </div>
              <span className="text-[10px] font-medium">Account</span>
            </Link>
          </div>
        </nav>
      </div>
    </div>
  );
}
