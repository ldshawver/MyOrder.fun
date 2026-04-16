import { useEffect, useRef, useState, type ReactNode } from "react";
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from "wouter";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useUser, useAuth } from '@clerk/react';
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useGetCurrentUser, setAuthTokenGetter } from "@workspace/api-client-react";
import NdaModal, { useNdaAccepted } from "@/components/nda-modal";
import SessionWatermark from "@/components/session-watermark";

import NotFound from "@/pages/not-found";
import PendingPage from "@/pages/pending";
import Home from "@/pages/home";
import WaitlistPage from "@/pages/waitlist";
import Terms from "@/pages/terms";
import Privacy from "@/pages/privacy";
import Dashboard from "@/pages/dashboard";
import Catalog from "@/pages/catalog";
import CatalogItemDetail from "@/pages/catalog-item";
import Orders from "@/pages/orders";
import OrderDetail from "@/pages/order-detail";
import NewOrder from "@/pages/new-order";
import AiConcierge from "@/pages/ai-concierge";
import GlobalAdmin from "@/pages/global-admin";
import GlobalAdminOnboarding from "@/pages/global-admin/onboarding";
import GlobalAdminTenants from "@/pages/global-admin/tenants";
import GlobalAdminAudit from "@/pages/global-admin/audit";
import StaffQueue from "@/pages/staff";
import Notifications from "@/pages/notifications";
import Account from "@/pages/account";
import AdminUsers from "@/pages/admin/users";
import MfaSetup from "@/pages/admin/mfa";
import AdminPrint from "@/pages/admin/print";
import AdminImport from "@/pages/admin/import";
import AdminInventory from "@/pages/admin/inventory";
import AdminSettingsPage from "@/pages/admin/settings-page";
import AdminCatalogDebug from "@/pages/admin/catalog-debug";
import Layout from "@/components/layout";

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
// Only use the proxy URL in production builds — in dev it points to the live
// domain which isn't reachable from Replit, causing Clerk JS to fail to load.
const clerkProxyUrl = import.meta.env.PROD
  ? (import.meta.env.VITE_CLERK_PROXY_URL ?? "").trim() || undefined
  : undefined;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

function AuthBrandWrapper({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden" style={{ background: "#0A0000" }}>
      <div className="pointer-events-none fixed inset-0" style={{ backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(180,0,0,0.015) 4px)" }} />
      <div className="pointer-events-none fixed inset-0 opacity-[0.03]" style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E\")", backgroundRepeat: "repeat", backgroundSize: "128px" }} />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full pointer-events-none" style={{ background: "radial-gradient(circle, rgba(220,20,60,0.08) 0%, transparent 70%)", filter: "blur(60px)" }} />
      <div className="relative z-10 flex flex-col items-center gap-6 w-full px-4">
        <div className="flex flex-col items-center gap-3 mb-2">
          <img src="/lc-icon.png" alt="Lucifer Cruz" className="w-12 h-12 object-contain" style={{ filter: "invert(1) brightness(1.2)" }} />
          <div className="text-center">
            <div className="font-bold tracking-[0.2em] text-base" style={{ color: "#C0C0C0" }}>LUCIFER CRUZ</div>
            <div className="text-[10px] font-mono tracking-[0.35em] uppercase mt-0.5" style={{ color: "#8B0000" }}>Adult Boutique · 18+</div>
          </div>
        </div>
        {children}
        <p className="text-[10px] font-mono mt-2" style={{ color: "#333" }}>ADULTS ONLY · 18+ · DISCREET · SECURE</p>
      </div>
    </div>
  );
}

function SignInPage() {
  return (
    <AuthBrandWrapper>
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </AuthBrandWrapper>
  );
}

function SignUpPage() {
  return (
    <AuthBrandWrapper>
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </AuthBrandWrapper>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        queryClient.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);

  return null;
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        {/* Customers land on the Order Concierge; admins/staff still have the dashboard in the nav */}
        <Redirect to="/ai-concierge" />
      </Show>
      <Show when="signed-out">
        <Home />
      </Show>
    </>
  );
}

const LoadingScreen = () => (
  <div className="h-screen w-full flex flex-col items-center justify-center gap-4" style={{ background: "#0A0000" }}>
    <img src="/lc-icon.png" alt="Lucifer Cruz" className="w-14 h-14 object-contain animate-pulse" style={{ filter: "invert(1) drop-shadow(0 0 24px rgba(220,20,60,0.6))" }} />
    <div className="text-xs font-mono tracking-[0.3em] uppercase" style={{ color: "#555" }}>Loading...</div>
  </div>
);

const BASE_API = import.meta.env.BASE_URL.replace(/\/$/, "");

function useSessionLogger(userEmail: string) {
  const [location] = useLocation();
  const { getToken } = useAuth();
  const lastPageRef = useRef<string>("");

  useEffect(() => {
    if (location === lastPageRef.current) return;
    lastPageRef.current = location;

    getToken().then(token => {
      if (!token) return;
      fetch(`${BASE_API}/api/session/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ page: location, action: "page_view" }),
      }).catch(() => {});
    });
  }, [location, getToken]);
}

function AuthenticatedApp() {
  const { isLoaded: clerkLoaded, isSignedIn } = useUser();
  const { data: user, isLoading, isError } = useGetCurrentUser({
    query: {
      queryKey: ["getCurrentUser"],
      enabled: clerkLoaded && isSignedIn === true,
      retry: 3,
      retryDelay: 800,
    },
  });

  const [ndaAccepted, setNdaAccepted] = useState(() => useNdaAccepted());

  useSessionLogger(user?.email ?? "");

  if (!clerkLoaded || isLoading) return <LoadingScreen />;
  if (isError) return <LoadingScreen />;
  if (!user) return <Redirect to="/waitlist" />;

  if ((user.status === "pending" || user.status === "rejected") && user.role !== "admin") {
    return <PendingPage status={user.status} />;
  }

  return (
    <>
      {!ndaAccepted && (
        <NdaModal userEmail={user.email} onAccept={() => setNdaAccepted(true)} />
      )}
      <SessionWatermark email={user.email} />
      <Layout user={user}>
        <Switch>
          <Route path="/dashboard" component={Dashboard} />
        
        {/* Catalog */}
        <Route path="/catalog" component={Catalog} />
        <Route path="/catalog/:id" component={CatalogItemDetail} />
        
        {/* Orders */}
        <Route path="/orders" component={Orders} />
        <Route path="/orders/new" component={NewOrder} />
        <Route path="/orders/:id" component={OrderDetail} />
        
        <Route path="/ai-concierge" component={AiConcierge} />
        
        {/* Role specific routes */}
        {user.role === "admin" && (
          <>
            <Route path="/global-admin" component={GlobalAdmin} />
            <Route path="/global-admin/onboarding" component={GlobalAdminOnboarding} />
            <Route path="/global-admin/tenants" component={GlobalAdminTenants} />
            <Route path="/global-admin/audit" component={GlobalAdminAudit} />
          </>
        )}

        {(user.role === "business_sitter" || user.role === "supervisor" || user.role === "admin") && (
          <Route path="/admin/inventory" component={AdminInventory} />
        )}
        {(user.role === "supervisor" || user.role === "admin") && (
          <>
            <Route path="/admin/users" component={AdminUsers} />
            <Route path="/admin/mfa" component={MfaSetup} />
            <Route path="/admin/print" component={AdminPrint} />
            <Route path="/admin/import" component={AdminImport} />
            <Route path="/admin/settings" component={AdminSettingsPage} />
            <Route path="/admin/catalog-debug" component={AdminCatalogDebug} />
          </>
        )}

        {(user.role === "business_sitter" || user.role === "supervisor" || user.role === "admin") && (
          <Route path="/staff" component={StaffQueue} />
        )}

        {/* User specific */}
        <Route path="/notifications" component={Notifications} />
        <Route path="/account" component={Account} />
        <Route component={NotFound} />
        </Switch>
      </Layout>
    </>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={HomeRedirect} />
      <Route path="/terms-of-service" component={Terms} />
      <Route path="/privacy" component={Privacy} />
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route path="/waitlist/*?" component={WaitlistPage} />
      <Route path="/onboarding">
        <Redirect to="/waitlist" />
      </Route>
      <Route path="/pending">
        <Show when="signed-in">
          <PendingPage />
        </Show>
        <Show when="signed-out">
          <Redirect to="/waitlist" />
        </Show>
      </Route>
      <Route>
        <Show when="signed-in">
          <AuthenticatedApp />
        </Show>
        <Show when="signed-out">
          <Redirect to="/waitlist" />
        </Show>
      </Route>
    </Switch>
  );
}

function ClerkAuthTokenSetter() {
  const { getToken } = useAuth();
  useEffect(() => {
    setAuthTokenGetter(() => getToken());
    return () => setAuthTokenGetter(null);
  }, [getToken]);
  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      waitlistUrl={`${basePath}/waitlist`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkAuthTokenSetter />
        <ClerkQueryClientCacheInvalidator />
        <Router />
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <TooltipProvider>
      <WouterRouter base={basePath}>
        <ClerkProviderWithRoutes />
      </WouterRouter>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
