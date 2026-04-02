import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { UserProfile } from "@workspace/api-client-react";
import { useClerk } from "@clerk/react";
import { 
  LayoutDashboard, 
  Box, 
  ShoppingCart, 
  MessageSquare, 
  ShieldAlert, 
  LogOut,
  Bell,
  Users,
  User,
  ShieldCheck,
  ListTodo
} from "lucide-react";

export default function Layout({ children, user }: { children: ReactNode, user: UserProfile }) {
  const [location] = useLocation();
  const { signOut } = useClerk();

  const navItems = [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["tenant_admin", "staff", "customer", "global_admin"] },
    { href: "/catalog", label: "Catalog", icon: Box, roles: ["tenant_admin", "staff", "customer", "global_admin"] },
    { href: "/orders", label: "Orders", icon: ShoppingCart, roles: ["tenant_admin", "staff", "customer", "global_admin"] },
    { href: "/ai-concierge", label: "Concierge", icon: MessageSquare, roles: ["tenant_admin", "staff", "customer", "global_admin"] },
    { href: "/staff", label: "Staff Queue", icon: ListTodo, roles: ["tenant_admin", "staff", "global_admin"] },
    { href: "/admin/users", label: "Users", icon: Users, roles: ["tenant_admin", "global_admin"] },
    { href: "/global-admin", label: "Platform Admin", icon: ShieldAlert, roles: ["global_admin"] },
  ];

  const visibleNavItems = navItems.filter(item => item.roles.includes(user.role));

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex font-sans">
      {/* Sidebar */}
      <div className="w-64 border-r border-border/50 bg-sidebar flex flex-col hidden md:flex shrink-0">
        <div className="p-6 border-b border-border/50">
          <div className="font-mono font-bold text-xl text-sidebar-foreground uppercase tracking-tight" data-testid="text-sidebar-logo">OrderFlow</div>
          {user.tenantName && (
            <div className="text-xs text-muted-foreground mt-1.5 font-medium truncate" data-testid="text-sidebar-tenant">{user.tenantName}</div>
          )}
        </div>
        
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-3">Menu</div>
          {visibleNavItems.map((item) => {
            const isActive = location === item.href || (location.startsWith(item.href + "/") && item.href !== "/dashboard" && item.href !== "/global-admin");
            const Icon = item.icon;
            
            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2 rounded-sm transition-colors text-sm ${
                  isActive 
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" 
                    : "text-sidebar-foreground hover:bg-sidebar-accent/50"
                }`}
                data-testid={`link-nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
              >
                <Icon size={16} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        
        <div className="p-4 border-t border-border/50 bg-card/30">
          <div className="flex items-center justify-between mb-4 px-2">
            <Link href="/account" className="flex items-center gap-2 flex-1 min-w-0 hover:opacity-80 transition-opacity" data-testid="link-account">
              <div className="w-8 h-8 rounded-sm bg-primary/20 text-primary flex items-center justify-center shrink-0">
                <User size={16} />
              </div>
              <div className="truncate">
                <div className="text-sm font-medium truncate" data-testid="text-user-name">{user.firstName || 'User'} {user.lastName}</div>
                <div className="text-xs text-muted-foreground truncate font-mono" data-testid="text-user-role">{user.role.replace('_', ' ')}</div>
              </div>
            </Link>
            <Link href="/notifications" className="text-muted-foreground hover:text-foreground shrink-0 p-2" data-testid="link-notifications">
              <Bell size={18} />
            </Link>
          </div>
          <button 
            onClick={() => signOut()}
            className="flex items-center gap-3 px-3 py-2 w-full text-left text-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive rounded-sm transition-colors"
            data-testid="button-sign-out"
          >
            <LogOut size={16} />
            <span>Sign Out</span>
          </button>
        </div>
      </div>
      
      {/* Main Content */}
      <div className="flex-1 flex flex-col h-[100dvh] overflow-hidden bg-background">
        <main className="flex-1 overflow-y-auto p-6 md:p-10">
          <div className="max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
