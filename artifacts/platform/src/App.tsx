import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { BrandProvider, useBrand } from "@/contexts/BrandContext";
import { CartProvider } from "@/contexts/CartContext";
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from "wouter";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useUser, useAuth } from "@clerk/react";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useGetCurrentUser, setAuthTokenGetter } from "@workspace/api-client-react";
import SensitiveScreen from "@/components/privacy/SensitiveScreen";
import NdaModal from "@/components/nda-modal";
import SessionWatermark from "@/components/session-watermark";
import Layout from "@/components/layout";
import { normalizeNotificationRole } from "@/hooks/usePushNotifications";
import { canAccessStaffRoute, normalizeApplicationRole } from "@/lib/routingPolicy";

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
import GlobalAdminIntegrations from "@/pages/global-admin/integrations";
import StaffQueue from "@/pages/staff";
import Notifications from "@/pages/notifications";
import Account from "@/pages/account";
import Profile from "@/pages/profile";
import Credits from "@/pages/credits";
import CsrSettings from "@/pages/csr-settings";
import AdminUsers from "@/pages/admin/users";
import MfaSetup from "@/pages/admin/mfa";
import AdminImport from "@/pages/admin/import";
import AdminInventory from "@/pages/admin/inventory";
import AdminSettingsPage from "@/pages/admin/settings-page";
import AdminEditCatalog from "@/pages/admin/edit-catalog";
import AdminReceipts from "@/pages/admin/receipts";
import AdminCloseouts from "@/pages/admin/closeouts";
import AdminFeedback from "@/pages/admin/feedback";
import AdminConciergeSettings from "@/pages/admin/concierge-settings";
import AdminCredits from "@/pages/admin/credits";
import AdminReports from "@/pages/admin/reports";
import AdminWebEditor from "@/pages/admin/web-editor";
import AdminVisualEditor from "@/pages/admin/visual-editor";
import AdminRolesPermissions from "@/pages/admin/roles-permissions";

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const isClerkDevelopmentInstance = clerkPubKey?.startsWith("pk_test_");

const clerkProxyUrl = import.meta.env.PROD && !isClerkDevelopmentInstance
  ? (import.meta.env.VITE_CLERK_PROXY_URL ?? "").trim() || undefined
  : undefined;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const BASE_API = import.meta.env.BASE_URL.replace(/\/$/, "");

const normalizeAppRole = normalizeApplicationRole;

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

function AuthBrandWrapper({ children }: { children: ReactNode }) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden"
      style={{ background: "#0A0000" }}
    >
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(180,0,0,0.015) 4px)",
        }}
      />
      <div
        className="pointer-events-none fixed inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E\")",
          backgroundRepeat: "repeat",
          backgroundSize: "128px",
        }}
      />
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full pointer-events-none"
        style={{
          background: "radial-gradient(circle, rgba(220,20,60,0.08) 0%, transparent 70%)",
          filter: "blur(60px)",
        }}
      />
      <div className="relative z-10 flex flex-col items-center gap-6 w-full px-4">
        <div className="flex flex-col items-center gap-3 mb-2">
          <img
            src="/myorder-logo-mobile.png"
            alt="MyOrder.fun"
            className="h-16 w-auto object-contain"
          />
          <div className="text-center">
            <div className="font-bold tracking-[0.12em] text-base" style={{ color: "#C0C0C0" }}>
              MYORDER.FUN
            </div>
            <div className="text-[10px] font-mono tracking-[0.35em] uppercase mt-0.5" style={{ color: "#8B0000" }}>
              Secure commerce platform
            </div>
          </div>
        </div>
        {children}
        <p className="text-[10px] font-mono mt-2" style={{ color: "#333" }}>
          TENANT-AWARE · SECURE · AUDITED
        </p>
      </div>
    </div>
  );
}

function SignInPage() {
  return (
    <AuthBrandWrapper>
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        forceRedirectUrl={`${basePath}/catalog`}
      />
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
  const queryClientInstance = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;

      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        queryClientInstance.clear();
      }

      prevUserIdRef.current = userId;
    });

    return unsubscribe;
  }, [addListener, queryClientInstance]);

  return null;
}

function canUseVisualEditor(role: string | null | undefined): boolean {
  const normalized = role?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return normalized === "global_admin" || normalized === "admin" || normalized === "tenant_admin";
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/catalog" />
      </Show>
      <Show when="signed-out">
        <Home />
      </Show>
    </>
  );
}

const LoadingScreen = () => (
  <div
    className="h-screen w-full flex flex-col items-center justify-center gap-4"
    style={{ background: "#0A0000" }}
  >
    <img
      src="/myorder-logo-mobile.png"
      alt="MyOrder.fun"
      className="h-20 w-auto object-contain animate-pulse"
    />
    <div className="text-xs font-mono tracking-[0.3em] uppercase" style={{ color: "#555" }}>
      Loading...
    </div>
  </div>
);

function useSessionLogger(_userEmail: string) {
  const [location] = useLocation();
  const { getToken } = useAuth();
  const lastPageRef = useRef<string>("");

  useEffect(() => {
    if (location === lastPageRef.current) return;

    lastPageRef.current = location;

    getToken()
      .then((token) => {
        if (!token) return;

        return fetch(`${BASE_API}/api/session/log`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ page: location, action: "page_view" }),
        });
      })
      .catch(() => {});
  }, [location, getToken]);
}

function AuthErrorScreen({
  onSignOut,
  onRetry,
}: {
  onSignOut: () => void;
  onRetry: () => void;
}) {
  return (
    <div
      className="h-screen w-full flex flex-col items-center justify-center gap-6"
      style={{ background: "#0A0000" }}
    >
      <img src="/myorder-logo-mobile.png" alt="MyOrder.fun" className="h-16 w-auto object-contain" />
      <div className="text-center flex flex-col gap-1">
        <p className="text-sm font-mono" style={{ color: "#C0C0C0" }}>
          Unable to load your account.
        </p>
        <p className="text-xs font-mono" style={{ color: "#444" }}>
          The server could not verify your session.
        </p>
      </div>
      <div className="flex gap-3">
        <button
          onClick={onRetry}
          className="px-4 py-2 rounded-lg text-xs font-mono tracking-widest uppercase"
          style={{
            background: "rgba(255,255,255,0.06)",
            color: "#C0C0C0",
            border: "1px solid rgba(255,255,255,0.1)",
          }}
        >
          Retry
        </button>
        <button
          onClick={onSignOut}
          className="px-4 py-2 rounded-lg text-xs font-mono tracking-widest uppercase"
          style={{ background: "#8B0000", color: "#C0C0C0" }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

function AuthenticatedApp() {
  const { isLoaded: clerkLoaded, isSignedIn, user: clerkUser } = useUser();
  const { signOut } = useClerk();
  const { getToken } = useAuth();
  const [authTokenReady, setAuthTokenReady] = useState(false);
  const { setBranding } = useBrand();

  useEffect(() => {
    let cancelled = false;

    setAuthTokenReady(false);

    if (!clerkLoaded || isSignedIn !== true) {
      return;
    }

    setAuthTokenGetter(() => getToken());

    getToken()
      .then((token) => {
        if (!cancelled) setAuthTokenReady(Boolean(token));
      })
      .catch(() => {
        if (!cancelled) setAuthTokenReady(false);
      });

    return () => {
      cancelled = true;
      setAuthTokenGetter(null);
    };
  }, [clerkLoaded, isSignedIn, getToken]);

  const {
    data: user,
    isLoading,
    isError,
    error,
  } = useGetCurrentUser({
    query: {
      queryKey: ["getCurrentUser"],
      enabled: clerkLoaded && isSignedIn === true && authTokenReady,
      retry: (failureCount: number, err: unknown) => {
        const e = err as { status?: number };
        if (e?.status === 403) return false;
        return failureCount < 3;
      },
      retryDelay: 800,
    },
  });

  const clerkEmail = clerkUser?.primaryEmailAddress?.emailAddress;

  useEffect(() => {
    let cancelled = false;
    if (!authTokenReady || !user) return;
    getToken()
      .then((token) => fetch("/api/branding", { headers: token ? { Authorization: `Bearer ${token}` } : {} }))
      .then((response) => response.ok ? response.json() : null)
      .then((branding) => { if (!cancelled && branding) setBranding(branding); })
      .catch(() => { /* platform defaults remain active */ });
    return () => { cancelled = true; };
  }, [authTokenReady, getToken, setBranding, user]);

  const [disclaimer, setDisclaimer] = useState<{ text: string; version: number; required: boolean } | null>(null);
  const [disclaimerLoading, setDisclaimerLoading] = useState(false);
  const [disclaimerAccepting, setDisclaimerAccepting] = useState(false);
  const [disclaimerError, setDisclaimerError] = useState<string | null>(null);

  const qc = useQueryClient();
  const [midSessionStatus, setMidSessionStatus] = useState<"pending" | "rejected" | null>(null);

  useEffect(() => {
    const cache = qc.getQueryCache();

    return cache.subscribe((event) => {
      if (event.type !== "updated") return;
      if (event.query.state.status !== "error") return;

      const queryKey = event.query.queryKey as unknown[];
      if (queryKey[0] === "getCurrentUser") return;

      const err = event.query.state.error as { status?: number; data?: { status?: string } } | null;
      if (err?.status !== 403) return;

      const apiStatus = err?.data?.status;
      setMidSessionStatus(apiStatus === "rejected" ? "rejected" : "pending");
    });
  }, [qc]);

  useSessionLogger(user?.email ?? "");

  useEffect(() => {
    let cancelled = false;
    if (!user || normalizeAppRole(user.role) !== "user") {
      setDisclaimer(null);
      return;
    }
    setDisclaimerLoading(true);
    setDisclaimerError(null);
    getToken()
      .then((token) => fetch("/api/customer/disclaimer", { headers: token ? { Authorization: `Bearer ${token}` } : {} }))
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Failed to load disclaimer");
        return res.json() as Promise<{ text: string; version: number; required: boolean }>;
      })
      .then((data) => { if (!cancelled) setDisclaimer(data.required ? data : null); })
      .catch((err) => { if (!cancelled) setDisclaimerError(err instanceof Error ? err.message : "Failed to load disclaimer"); })
      .finally(() => { if (!cancelled) setDisclaimerLoading(false); });
    return () => { cancelled = true; };
  }, [getToken, user]);

  async function acceptDisclaimer() {
    if (!disclaimer) return;
    setDisclaimerAccepting(true);
    setDisclaimerError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/customer/disclaimer/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ version: disclaimer.version }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Failed to accept disclaimer");
      setDisclaimer(null);
    } catch (err) {
      setDisclaimerError(err instanceof Error ? err.message : "Failed to accept disclaimer");
    } finally {
      setDisclaimerAccepting(false);
    }
  }

  async function refreshCurrentUser() {
    await qc.invalidateQueries({ queryKey: ["getCurrentUser"] });
    await qc.refetchQueries({ queryKey: ["getCurrentUser"] });

    const state = qc.getQueryState(["getCurrentUser"]);
    if (state?.status === "error") {
      throw new Error("Failed to check status");
    }
  }

  async function handleCheckStatus() {
    await refreshCurrentUser();
  }

  async function handleMidSessionCheckStatus() {
    setMidSessionStatus(null);
    await refreshCurrentUser();
  }

  if (midSessionStatus) {
    return (
      <PendingPage
        status={midSessionStatus}
        userEmail={user?.email ?? clerkEmail}
        onCheckStatus={midSessionStatus === "pending" ? handleMidSessionCheckStatus : undefined}
      />
    );
  }

  if (!clerkLoaded || !authTokenReady || isLoading || disclaimerLoading) return <LoadingScreen />;

  if (isError) {
    const err = error as { status?: number; data?: { status?: string } } | null;

    if (err?.status === 403) {
      const apiStatus = err?.data?.status;

      if (apiStatus === "rejected") {
        return <PendingPage status="rejected" userEmail={clerkEmail} />;
      }

      return <PendingPage status="pending" userEmail={clerkEmail} onCheckStatus={handleCheckStatus} />;
    }

    return (
      <AuthErrorScreen
        onSignOut={() => signOut(() => window.location.replace(`${basePath}/sign-in`))}
        onRetry={() => refreshCurrentUser().catch(() => {})}
      />
    );
  }

  if (!user) return <Redirect to="/sign-in" />;

  const normalizedRole = normalizeNotificationRole(user.role);
  const isGlobalAdmin = normalizedRole === "global_admin";
  const isAdmin = normalizedRole === "admin" || isGlobalAdmin;
  const isStaff = canAccessStaffRoute(user.role);
  const appRole = normalizeAppRole(user.role);


  const privacyUser = user as typeof user & { privacyModeEnabled?: boolean; sensitiveScreensProtectionEnabled?: boolean; watermarkSensitiveScreens?: boolean; privacyBlurOnBackground?: boolean; privacyPrintBlockingEnabled?: boolean; tenantName?: string | null; companyName?: string | null };
  const privacySettings = {
    privacyModeEnabled: privacyUser.privacyModeEnabled ?? true,
    sensitiveScreensProtectionEnabled: privacyUser.sensitiveScreensProtectionEnabled ?? true,
    watermarkSensitiveScreens: privacyUser.watermarkSensitiveScreens ?? true,
    blurOnBackground: privacyUser.privacyBlurOnBackground ?? true,
    printBlockingEnabled: privacyUser.privacyPrintBlockingEnabled ?? true,
  };
  const protect = (node: ReactNode) => (
    <SensitiveScreen userEmail={user.email} userRole={user.role} tenantName={privacyUser.tenantName ?? privacyUser.companyName ?? null} {...privacySettings}>
      {node}
    </SensitiveScreen>
  );

  if ((user.status === "pending" || user.status === "rejected") && !isAdmin) {
    return (
      <PendingPage
        status={user.status}
        userEmail={user.email}
        onCheckStatus={user.status === "pending" ? handleCheckStatus : undefined}
      />
    );
  }

  return (
    <>
      {disclaimer && <NdaModal userEmail={user.email} text={disclaimer.text} version={disclaimer.version} accepting={disclaimerAccepting} error={disclaimerError} onAccept={acceptDisclaimer} />}
      <SessionWatermark email={user.email} />
      <Layout user={user}>
        <Switch>
          <Route path="/dashboard" component={Dashboard} />

          <Route path="/catalog" component={Catalog} />
          <Route path="/catalog/:id" component={CatalogItemDetail} />

          <Route path="/orders" component={Orders} />
          <Route path="/orders/new" component={NewOrder} />
          <Route path="/orders/:id">{() => protect(<OrderDetail />)}</Route>

          <Route path="/ai-concierge" component={AiConcierge} />

          {/* Keep this direct route ahead of conditional route fragments. Wouter's
              Switch treats a fragment as a candidate, which previously shadowed
              /staff for supervisor and admin sessions. */}
          {isStaff && <Route path="/staff">{() => protect(<StaffQueue />)}</Route>}

          {appRole === "global_admin" && (
            <>
              <Route path="/global-admin" component={GlobalAdmin} />
              <Route path="/global-admin/onboarding" component={GlobalAdminOnboarding} />
              <Route path="/global-admin/tenants" component={GlobalAdminTenants} />
              <Route path="/global-admin/audit" component={GlobalAdminAudit} />
              <Route path="/global-admin/integrations" component={GlobalAdminIntegrations} />
            </>
          )}

          {isStaff && <Route path="/admin/inventory">{() => protect(<AdminInventory />)}</Route>}

          {["global_admin", "admin"].includes(appRole) && (
            <>
              <Route path="/admin/users">{() => protect(<AdminUsers />)}</Route>
              <Route path="/admin/roles-permissions">{() => protect(<AdminRolesPermissions />)}</Route>
              <Route path="/admin/mfa" component={MfaSetup} />
              <Route path="/admin/import" component={AdminImport} />
              <Route path="/admin/settings">{() => protect(<AdminSettingsPage />)}</Route>
              <Route path="/admin/edit-catalog" component={AdminEditCatalog} />
              <Route path="/admin/receipts">{() => protect(<AdminReceipts />)}</Route>
              <Route path="/admin/closeouts" component={AdminCloseouts} />
              <Route path="/admin/feedback" component={AdminFeedback} />
              <Route path="/admin/concierge-settings" component={AdminConciergeSettings} />
              <Route path="/admin/credits" component={AdminCredits} />
              <Route path="/admin/reports">{() => protect(<AdminReports />)}</Route>
              <Route path="/admin/web-editor" component={AdminWebEditor} />

              {canUseVisualEditor(user.role) && (
                <>
                  <Route path="/admin/visual-editor/:pageId/preview" component={AdminVisualEditor} />
                  <Route path="/admin/visual-editor/:pageId" component={AdminVisualEditor} />
                  <Route path="/admin/visual-editor" component={AdminVisualEditor} />
                </>
              )}
            </>
          )}

          {appRole === "supervisor" && (
            <>
              <Route path="/admin/users">{() => protect(<AdminUsers />)}</Route>
              <Route path="/admin/closeouts">{() => protect(<AdminCloseouts />)}</Route>
              <Route path="/admin/feedback" component={AdminFeedback} />
            </>
          )}

          {isStaff && (
            <>
              <Route path="/csr-settings" component={CsrSettings} />
              <Route path="/csr-settings/:section" component={CsrSettings} />
            </>
          )}

          <Route path="/notifications" component={Notifications} />
          <Route path="/account">{() => protect(<Account />)}</Route>
          <Route path="/profile">{() => protect(<Profile />)}</Route>
          <Route path="/credits" component={Credits} />
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

class ClerkInitializationBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Clerk initialization failed", error, info);
  }

  render() {
    if (this.state.failed) {
      return <ClerkInitializationError />;
    }

    return this.props.children;
  }
}

export function ClerkInitializationError() {
  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <section
        role="alert"
        className="w-full max-w-lg rounded-2xl border border-destructive/40 bg-card p-6 shadow-xl"
      >
        <h1 className="text-xl font-semibold">Authentication unavailable</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Clerk could not initialize. Reload the page or contact support if the problem continues.
        </p>
        <p className="mt-4 font-mono text-xs text-destructive">
          CLERK_INITIALIZATION_FAILED
        </p>
      </section>
    </main>
  );
}

function App() {
  return (
    <BrandProvider>
      <CartProvider>
        <TooltipProvider>
          <WouterRouter base={basePath}>
            <ClerkInitializationBoundary>
              <ClerkProviderWithRoutes />
            </ClerkInitializationBoundary>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </CartProvider>
    </BrandProvider>
  );
}

export default App;
