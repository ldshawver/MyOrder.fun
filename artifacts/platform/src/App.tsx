import { useEffect, useRef } from "react";
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from "wouter";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useUser, useAuth } from '@clerk/react';
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useGetCurrentUser, setAuthTokenGetter } from "@workspace/api-client-react";

import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import Onboarding from "@/pages/onboarding";
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
import Layout from "@/components/layout";

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

function SignInPage() {
  return (
    <div className="flex justify-center mt-16">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex justify-center mt-16">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
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
        <Redirect to="/dashboard" />
      </Show>
      <Show when="signed-out">
        <Home />
      </Show>
    </>
  );
}

function AuthenticatedApp() {
  const { data: user, isLoading } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  
  if (isLoading) return (
    <div className="h-screen w-full flex flex-col items-center justify-center bg-background text-foreground gap-4">
      <img src="/alavont-logo.png" alt="Alavont" className="w-16 h-16 object-contain animate-pulse" style={{ filter: "drop-shadow(0 0 24px hsl(214 90% 55% / 0.5))" }} />
      <div className="text-sm text-muted-foreground font-medium tracking-wider">Loading...</div>
    </div>
  );
  if (!user) return <Redirect to="/sign-in" />;

  return (
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
        {user.role === "global_admin" && (
          <>
            <Route path="/global-admin" component={GlobalAdmin} />
            <Route path="/global-admin/onboarding" component={GlobalAdminOnboarding} />
            <Route path="/global-admin/tenants" component={GlobalAdminTenants} />
            <Route path="/global-admin/audit" component={GlobalAdminAudit} />
          </>
        )}

        {(user.role === "tenant_admin" || user.role === "global_admin") && (
          <>
            <Route path="/admin/users" component={AdminUsers} />
            <Route path="/admin/mfa" component={MfaSetup} />
            <Route path="/admin/print" component={AdminPrint} />
          </>
        )}

        {(user.role === "staff" || user.role === "tenant_admin" || user.role === "global_admin") && (
          <Route path="/staff" component={StaffQueue} />
        )}

        {/* User specific */}
        <Route path="/notifications" component={Notifications} />
        <Route path="/account" component={Account} />

        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={HomeRedirect} />
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route path="/onboarding" component={Onboarding} />
      <Route>
        <Show when="signed-in">
          <AuthenticatedApp />
        </Show>
        <Show when="signed-out">
          <Redirect to="/sign-in" />
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
