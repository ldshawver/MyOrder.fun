import { ReactNode, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Link, useLocation } from "wouter";
import { UserProfile } from "@workspace/api-client-react";
import { useClerk } from "@clerk/react";
import { useBrand } from "@/contexts/BrandContext";
import { 
  FlaskConical, 
  ShoppingCart, 
  MessageSquare, 
  ShieldAlert, 
  LogOut,
  Bell,
  User,
  ListTodo,
  Menu,
  X,
  ChevronRight,
  Upload,
  Settings,
  ClipboardList,
  ReceiptText,
  ClipboardCheck,
  UserCheck,
  Bot,
  BadgeDollarSign,
  BarChart3,
  MapPin,
  ChevronDown,
  PackageOpen,
  Store,
  Wifi,
  Zap,
  Palette,
  PanelsTopLeft,
  PlugZap,
} from "lucide-react";
import { normalizeNotificationRole, usePushNotifications } from "@/hooks/usePushNotifications";
import { FloatingFeedbackButton } from "@/components/FloatingFeedbackButton";
import { useListNotifications, getListNotificationsQueryKey } from "@workspace/api-client-react";

type NavItem = {
  href: string;
  label: string;
  mobileLabel?: string;
  icon: typeof FlaskConical;
  roles: string[];
  mobileShow?: boolean;
  children?: NavItem[];
};

type NavSection = {
  title: string;
  roles: string[];
  defaultOpen?: boolean;
  items: NavItem[];
};

function roleCanSee(roles: string[], userRole: string): boolean {
  return roles.includes(userRole) || (userRole === "global_admin" && roles.includes("admin"));
}

export default function Layout({ children, user }: { children: ReactNode, user: UserProfile }) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    navigation: true,
    csr: true,
    admin: false,
    platform: false,
  });
  const { brand } = useBrand();
  const isLC = brand === "lucifer_cruz";

  const userRole = normalizeNotificationRole(user.role);
  const notificationRole = userRole;

  usePushNotifications({ role: notificationRole });

  const { data: notifData } = useListNotifications(
    {},
    { query: { queryKey: getListNotificationsQueryKey({}), refetchInterval: 30000 } }
  );
  const unreadCount = notifData?.unreadCount ?? 0;

  // Staff roles that can run a shift / see the CSR queue + clock-in
  const SHIFT_ROLES = ["global_admin", "admin", "supervisor", "csr"];
  const ALL_ROLES = [...SHIFT_ROLES, "user"];
  const isCustomer = userRole === "user";

  const navSections: NavSection[] = [
    {
      title: "Navigation",
      roles: ALL_ROLES,
      items: [
        { href: "/catalog", label: "Catalog", icon: FlaskConical, roles: ALL_ROLES, mobileShow: true },
        {
          href: "/orders",
          label: isCustomer ? "Order" : "Orders",
          mobileLabel: isCustomer ? "Order" : "Orders",
          icon: ShoppingCart,
          roles: ALL_ROLES,
          mobileShow: true,
        },
        {
          href: "/ai-concierge",
          label: "Zappy Concierge",
          mobileLabel: "Zappy",
          icon: MessageSquare,
          roles: ALL_ROLES,
          mobileShow: true,
        },
        {
          href: "/profile",
          label: "User Account",
          icon: User,
          roles: ALL_ROLES,
          children: [
            { href: "/profile", label: "Profile", icon: User, roles: ALL_ROLES },
            { href: "/account", label: "Account Settings", icon: Settings, roles: ALL_ROLES },
            { href: "/credits", label: "Credit", icon: BadgeDollarSign, roles: ALL_ROLES },
            { href: "/notifications", label: "Notifications", icon: Bell, roles: ALL_ROLES },
          ],
        },
      ],
    },
    {
      title: "Customer Service Rep",
      roles: SHIFT_ROLES,
      defaultOpen: true,
      items: [
        { href: "/staff", label: "Shift / Queue", icon: ListTodo, roles: SHIFT_ROLES },
        {
          href: "/csr-settings",
          label: "CSR Settings",
          icon: MapPin,
          roles: SHIFT_ROLES,
          children: [
            { href: "/csr-settings/pickup", label: "Pickup Instructions", icon: ClipboardList, roles: SHIFT_ROLES },
            { href: "/csr-settings/shift", label: "Shift Settings", icon: Settings, roles: SHIFT_ROLES },
            { href: "/csr-settings/wifi", label: "WIFI", icon: Wifi, roles: SHIFT_ROLES },
            { href: "/csr-settings/location", label: "Shift Location", icon: Store, roles: SHIFT_ROLES },
          ],
        },
      ],
    },
    {
      title: "Supervisor",
      roles: ["global_admin", "admin"],
      items: [
        {
          href: "/admin/settings",
          label: "Settings",
          icon: Settings,
          roles: ["global_admin", "admin"],
          children: [
            { href: "/admin/receipts", label: "Receipts & Printers", icon: ReceiptText, roles: ["global_admin", "admin"] },
          ],
        },
        {
          href: "/admin/edit-catalog",
          label: "Products",
          icon: PackageOpen,
          roles: ["global_admin", "admin"],
          children: [
            { href: "/admin/edit-catalog", label: "Edit Catalog", icon: PackageOpen, roles: ["global_admin", "admin"] },
            { href: "/admin/import", label: "Import Menu", icon: Upload, roles: ["global_admin", "admin"] },
          ],
        },
        { href: "/admin/closeouts", label: "Shift Closeouts", icon: ClipboardCheck, roles: ["global_admin", "admin"] },
        {
          href: "/admin/concierge-settings",
          label: "AI Concierge",
          icon: Bot,
          roles: ["global_admin", "admin"],
          children: [
            { href: "/admin/concierge-settings", label: "Upsells", icon: PackageOpen, roles: ["global_admin", "admin"] },
            { href: "/admin/edit-catalog", label: "Sales & Packages", icon: PackageOpen, roles: ["global_admin", "admin"] },
          ],
        },
        { href: "/admin/inventory", label: "Inventory & Par", icon: ClipboardList, roles: SHIFT_ROLES },
        { href: "/admin/reports", label: "Reports", icon: BarChart3, roles: ["global_admin", "admin"] },
        { href: "/admin/visual-editor", label: "Visual Editor", icon: PanelsTopLeft, roles: ["global_admin", "admin"] },
      ],
    },
    {
      title: "Platform Admin",
      roles: ["global_admin"],
      items: [
        { href: "/admin/users", label: "Users", icon: UserCheck, roles: ["global_admin", "admin"] },
        { href: "/admin/roles-permissions", label: "Roles & Permissions", icon: UserCheck, roles: ["global_admin", "admin"] },
        { href: "/global-admin", label: "Emergency Kill Switch", icon: Zap, roles: ["global_admin", "admin"] },
        { href: "/global-admin/integrations", label: "Platform Integrations", icon: PlugZap, roles: ["global_admin"] },
        { href: "/admin/feedback", label: "Feedback", icon: MessageSquare, roles: ["global_admin", "admin", "admin"] },
        { href: "/admin/edit-catalog", label: "Edit Catalog", icon: FlaskConical, roles: ["global_admin", "admin"] },
        { href: "/admin/web-editor", label: "Web Editor", icon: Palette, roles: ["global_admin", "admin"] },
        {
          href: "/admin/settings",
          label: "Admin Settings",
          icon: ShieldAlert,
          roles: ["global_admin", "admin"],
          children: [
            { href: "/admin/receipts", label: "Receipts & Printers", icon: ReceiptText, roles: ["global_admin"] },
            { href: "/admin/import", label: "Import Menu", icon: Upload, roles: ["global_admin"] },
            { href: "/admin/concierge-settings", label: "AI Concierge", icon: Bot, roles: ["global_admin"] },
            { href: "/admin/inventory", label: "Edit Inventory & Par", icon: ClipboardList, roles: ["global_admin"] },
            { href: "/admin/credits", label: "Merchant Services", icon: BadgeDollarSign, roles: ["global_admin"] },
            { href: "/admin/roles-permissions", label: "Roles & Permissions", icon: ShieldAlert, roles: ["global_admin"] },
          ],
        },
      ],
    },
  ];

  const visibleSections = navSections
    .filter(section => roleCanSee(section.roles, userRole))
    .map(section => ({
      ...section,
      items: section.items
        .filter(item => roleCanSee(item.roles, userRole))
        .map(item => ({
          ...item,
          children: item.children?.filter(child => roleCanSee(child.roles, userRole)),
        })),
    }))
    .filter(section => section.items.length > 0);
  const visibleNavItems = visibleSections.flatMap(section => section.items.flatMap(item => [item, ...(item.children ?? [])]));
  const mobileNavItems = visibleNavItems.filter(item => item.mobileShow);

  function isActive(href: string) {
    return location === href || (location.startsWith(href + "/") && href !== "/global-admin");
  }

  function sectionKey(title: string) {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  }

  function renderNavItem(item: NavItem, closeMobile = false, nested = false) {
    const active = isActive(item.href);
    const childActive = item.children?.some(child => isActive(child.href)) ?? false;
    const Icon = item.icon;
    return (
      <div key={`${item.href}-${item.label}`} className={nested ? "" : "space-y-0.5"}>
        <Link
          href={item.href}
          onClick={closeMobile ? () => setMobileMenuOpen(false) : undefined}
          className={`flex items-center gap-3 px-3 py-2 rounded-md transition-all text-sm group relative ${
            active || childActive
              ? "bg-primary/15 text-primary font-semibold"
              : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-foreground"
          } ${nested ? "ml-6 py-1.5 text-xs" : ""}`}
          data-testid={`link-nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
        >
          {(active || childActive) && (
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-r-full" />
          )}
          <span className="relative shrink-0">
            <Icon size={nested ? 13 : 15} className={active || childActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"} />
            {item.href === "/notifications" && unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-destructive border border-sidebar" data-testid="badge-notif-dot" />
            )}
          </span>
          <span className="truncate">{item.label}</span>
          {item.href === "/notifications" && unreadCount > 0 && !active && (
            <span className="ml-auto text-[10px] font-bold text-destructive" data-testid="badge-notif-count">{unreadCount}</span>
          )}
          {active && <ChevronRight size={13} className="ml-auto text-primary/60" />}
        </Link>
        {item.children?.map(child => renderNavItem(child, closeMobile, true))}
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex font-sans">

      {/* ── Desktop Sidebar ──────────────────────────────────────────── */}
      <aside className="w-64 border-r border-border/50 bg-sidebar flex-col hidden md:flex shrink-0">
        {/* Logo */}
        <div className="p-5 border-b border-border/40">
          <Link href="/catalog" className="flex items-center gap-3 group">
            {isLC ? (
              <img
                src="/lc-icon.png"
                alt="Lucifer Cruz"
                className="w-9 h-9 object-contain group-hover:scale-105 transition-transform"
                style={{ filter: "invert(1) brightness(1.15)" }}
              />
            ) : (
              <img
                src="/alavont-logo-glow.png"
                alt="Alavont"
                className="w-9 h-9 object-contain group-hover:scale-105 transition-transform"
              />
            )}
            <div>
              <div className="font-bold text-sm tracking-wide text-foreground" data-testid="text-sidebar-logo">
                {isLC ? "LUCIFER CRUZ" : "ALAVONT"}
              </div>
              <div className="text-[10px] text-primary/80 font-medium tracking-widest uppercase">
                {isLC ? "Adult Boutique" : "Premium Platform"}
              </div>
            </div>
          </Link>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-2 overflow-y-auto">
          {visibleSections.map((section) => {
            const key = sectionKey(section.title);
            const open = openSections[key] ?? section.defaultOpen ?? section.title === "Navigation";
            return (
              <div key={section.title}>
                <button
                  type="button"
                  onClick={() => setOpenSections(prev => ({ ...prev, [key]: !open }))}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-widest hover:text-foreground"
                >
                  <span>{section.title}</span>
                  <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
                </button>
                {open && <div className="space-y-0.5">{section.items.map(item => renderNavItem(item))}</div>}
              </div>
            );
          })}
        </nav>

        {/* User footer */}
        <div className="p-3 border-t border-border/40 space-y-1">
          <Link
            href="/profile"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all group hover:bg-sidebar-accent/60"
            data-testid="link-profile"
          >
            <div className="w-8 h-8 rounded-full bg-primary/20 text-primary flex items-center justify-center shrink-0 border border-primary/30 overflow-hidden">
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt="Avatar" className="w-full h-full object-cover" data-testid="img-user-avatar" />
              ) : (
                <User size={14} />
              )}
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
              <Link href="/catalog" className="flex items-center gap-3" onClick={() => setMobileMenuOpen(false)}>
                {isLC ? (
                  <img src="/lc-icon.png" alt="Lucifer Cruz" className="w-8 h-8 object-contain" style={{ filter: "invert(1) brightness(1.15)" }} />
                ) : (
                  <img src="/alavont-logo-glow.png" alt="Alavont" className="w-8 h-8 object-contain" />
                )}
                <div>
                  <div className="font-bold text-sm tracking-wide">{isLC ? "LUCIFER CRUZ" : "ALAVONT"}</div>
                  <div className="text-[10px] text-primary/80 tracking-widest uppercase">{isLC ? "Adult Boutique" : "Premium Platform"}</div>
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

            <nav className="flex-1 p-3 space-y-3 overflow-y-auto">
              {visibleSections.map((section) => {
                return (
                  <div key={section.title}>
                    <div className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-widest px-3 py-1.5">
                      {section.title}
                    </div>
                    <div className="space-y-0.5">{section.items.map(item => renderNavItem(item, true))}</div>
                  </div>
                );
              })}
            </nav>

            <div className="p-3 border-t border-border/40 space-y-1">
              <Link
                href="/profile"
                onClick={() => setMobileMenuOpen(false)}
                className="flex items-center gap-3 px-4 py-3 rounded-xl"
              >
                <div className="w-9 h-9 rounded-full bg-primary/20 flex items-center justify-center border border-primary/30 overflow-hidden">
                  {user.avatarUrl ? (
                    <img src={user.avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
                  ) : (
                    <User size={15} />
                  )}
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
          <Link href="/catalog" className="flex items-center gap-2">
            {isLC ? (
              <img src="/lc-icon.png" alt="Lucifer Cruz" className="w-7 h-7 object-contain" style={{ filter: "invert(1) brightness(1.15)" }} />
            ) : (
              <img src="/alavont-logo-glow.png" alt="Alavont" className="w-7 h-7 object-contain" />
            )}
            <span className="font-bold text-sm tracking-wide">{isLC ? "LUCIFER CRUZ" : "ALAVONT"}</span>
          </Link>
          <Link href="/notifications" className="relative text-muted-foreground hover:text-foreground p-1.5 rounded-lg hover:bg-sidebar-accent/60 transition-colors">
            <Bell size={20} />
            {unreadCount > 0 && (
              <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-destructive border-2 border-sidebar" data-testid="badge-notif-dot-mobile" />
            )}
          </Link>
        </header>

        {/* Page content with animated transitions */}
        <main className="flex-1 overflow-y-auto relative">
          {/* Electric flash overlay — fires on every route change */}
          <motion.div
            key={`flash-${location}`}
            className="absolute inset-0 pointer-events-none"
            style={{
              background: "linear-gradient(135deg, rgba(59,130,246,0.13), rgba(139,92,246,0.08))",
              zIndex: 10,
            }}
            initial={{ opacity: 1 }}
            animate={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          />

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={location}
              className="p-4 md:p-8 max-w-7xl mx-auto pb-24 md:pb-8"
              initial={{ opacity: 0, y: 18, scale: 0.99 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 1.01 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>

        {/* Floating Feedback button — sits above the mobile tab bar */}
        <FloatingFeedbackButton />

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
                  <span className="text-[10px] font-medium">{item.mobileLabel ?? item.label}</span>
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
