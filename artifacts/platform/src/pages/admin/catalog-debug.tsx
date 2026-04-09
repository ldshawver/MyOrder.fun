import { useState, useCallback } from "react";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Search, RefreshCw, CheckCircle, AlertTriangle, XCircle, Eye, EyeOff,
  Database, Package, Flame, FlaskConical, Image, Tag, Link2, Loader2
} from "lucide-react";

type DebugSummary = {
  totalRows: number;
  visibleAlavont: number;
  visibleLC: number;
  hiddenUnavailable: number;
  hiddenMissingAlavontName: number;
  hiddenMissingLCName: number;
  missingPrice: number;
  missingLabName: number;
  missingImage: number;
  missingRequiredFields: number;
  categoryCounts: { category: string; count: number }[];
};

type DebugItem = {
  id: number;
  tenantId: number;
  name: string;
  alavontName: string | null;
  alavontId: string | null;
  regularPrice: number | null;
  alavontCategory: string | null;
  alavontInStock: boolean | null;
  luciferCruzName: string | null;
  luciferCruzCategory: string | null;
  labName: string | null;
  isAvailable: boolean;
  hasImage: boolean;
  alavontImageUrl: string | null;
  imageUrl: string | null;
  missingFields: string[];
  filteredBecause: string[];
  visibleAlavont: boolean;
  visibleLC: boolean;
};

type DebugResponse = { summary: DebugSummary; items: DebugItem[] };

type WooStatus = { configured: boolean; storeUrl: string };

function StatCard({ label, value, icon: Icon, color }: { label: string; value: number; icon: any; color: string }) {
  return (
    <div className="glass-card rounded-xl p-4 flex items-center gap-3">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${color}`}>
        <Icon size={18} />
      </div>
      <div>
        <div className="text-2xl font-bold">{value}</div>
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">{label}</div>
      </div>
    </div>
  );
}

function VisibilityBadge({ visible, label }: { visible: boolean; label: string }) {
  return visible ? (
    <span className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
      <Eye size={8} /> {label}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20">
      <EyeOff size={8} /> {label}
    </span>
  );
}

export default function CatalogDebug() {
  const { data: userRes } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const user = userRes;
  const { getToken } = useAuth();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "hidden" | "missing">("all");
  const [wcKey, setWcKey] = useState("");
  const [wcSecret, setWcSecret] = useState("");
  const [wcUrl, setWcUrl] = useState("");
  const [wcResult, setWcResult] = useState<any>(null);
  const qc = useQueryClient();

  const authFetch = useCallback(async (path: string, init?: RequestInit) => {
    const token = await getToken();
    return fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
  }, [getToken]);

  const { data, isLoading, refetch } = useQuery<DebugResponse>({
    queryKey: ["admin-catalog-debug"],
    queryFn: async () => {
      const resp = await authFetch("/api/admin/catalog/debug");
      if (!resp.ok) throw new Error(await resp.text());
      return resp.json();
    },
  });

  const { data: wooStatus } = useQuery<WooStatus>({
    queryKey: ["woo-status"],
    queryFn: async () => {
      const resp = await authFetch("/api/admin/woocommerce/status");
      if (!resp.ok) throw new Error("Could not fetch WooCommerce status");
      return resp.json();
    },
  });

  const wooSync = useMutation({
    mutationFn: async (body: { storeUrl?: string; consumerKey: string; consumerSecret: string }) => {
      const resp = await authFetch("/api/admin/woocommerce/sync", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error ?? "Sync failed");
      return json;
    },
    onSuccess: (result) => {
      setWcResult(result);
      qc.invalidateQueries({ queryKey: ["admin-catalog-debug"] });
      refetch();
    },
  });

  if (!user || (user.role !== "tenant_admin" && user.role !== "global_admin")) {
    return (
      <div className="glass-card rounded-2xl p-8 text-center">
        <XCircle className="mx-auto text-red-400 mb-3" size={32} />
        <div className="text-sm font-semibold">Admin access required</div>
      </div>
    );
  }

  const summary = data?.summary;
  const allItems = data?.items ?? [];

  const filtered = allItems.filter(item => {
    const matchesSearch =
      !search ||
      (item.alavontName ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (item.luciferCruzName ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (item.labName ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (item.name ?? "").toLowerCase().includes(search.toLowerCase()) ||
      String(item.id).includes(search);

    const matchesFilter =
      filter === "all" ||
      (filter === "hidden" && (!item.visibleAlavont || !item.visibleLC)) ||
      (filter === "missing" && item.missingFields.length > 0);

    return matchesSearch && matchesFilter;
  });

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Catalog Debug</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Diagnose why products may not appear in the catalog</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="rounded-xl text-xs h-9 gap-1.5"
          onClick={() => refetch()}
          disabled={isLoading}
        >
          <RefreshCw size={12} className={isLoading ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>

      {/* Summary Stats */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <StatCard label="Total in DB" value={summary.totalRows} icon={Database} color="bg-primary/10 text-primary" />
          <StatCard label="Visible (Alavont)" value={summary.visibleAlavont} icon={FlaskConical} color="bg-blue-500/10 text-blue-400" />
          <StatCard label="Visible (LC)" value={summary.visibleLC} icon={Flame} color="bg-red-500/10 text-red-400" />
          <StatCard label="Missing Fields" value={summary.missingRequiredFields} icon={AlertTriangle} color="bg-amber-500/10 text-amber-400" />
          <StatCard label="Unavailable" value={summary.hiddenUnavailable} icon={EyeOff} color="bg-zinc-500/10 text-zinc-400" />
        </div>
      )}

      {/* Diagnostics Callouts */}
      {summary && (
        <div className="space-y-2">
          {summary.totalRows === 0 && (
            <div className="glass-card rounded-xl p-4 border border-amber-500/30 bg-amber-500/5 flex items-center gap-3">
              <AlertTriangle size={16} className="text-amber-400 shrink-0" />
              <span className="text-sm font-medium text-amber-300">No products imported — use the Import Menu page to upload a CSV.</span>
            </div>
          )}
          {summary.totalRows > 0 && summary.visibleAlavont === 0 && (
            <div className="glass-card rounded-xl p-4 border border-red-500/30 bg-red-500/5 flex items-center gap-3">
              <XCircle size={16} className="text-red-400 shrink-0" />
              <span className="text-sm font-medium text-red-300">
                {summary.totalRows} products exist in DB but <strong>none are visible in the Alavont catalog</strong>.
                {summary.hiddenMissingAlavontName > 0 && ` ${summary.hiddenMissingAlavontName} are missing alavont_name.`}
                {summary.hiddenUnavailable > 0 && ` ${summary.hiddenUnavailable} are marked unavailable.`}
              </span>
            </div>
          )}
          {summary.visibleAlavont > 0 && summary.visibleLC === 0 && (
            <div className="glass-card rounded-xl p-4 border border-orange-500/30 bg-orange-500/5 flex items-center gap-3">
              <AlertTriangle size={16} className="text-orange-400 shrink-0" />
              <span className="text-sm font-medium text-orange-300">
                Products show in Alavont mode but <strong>none appear in the Lucifer Cruz tab</strong> — {summary.hiddenMissingLCName} rows are missing lucifer_cruz_name.
              </span>
            </div>
          )}
          {summary.missingImage > 0 && (
            <div className="glass-card rounded-xl p-4 border border-blue-500/20 bg-blue-500/5 flex items-center gap-3">
              <Image size={16} className="text-blue-400 shrink-0" />
              <span className="text-sm text-blue-300">{summary.missingImage} products have no image (will show placeholder icon).</span>
            </div>
          )}
          {summary.totalRows > 0 && summary.visibleAlavont > 0 && summary.visibleLC > 0 && (
            <div className="glass-card rounded-xl p-4 border border-emerald-500/20 bg-emerald-500/5 flex items-center gap-3">
              <CheckCircle size={16} className="text-emerald-400 shrink-0" />
              <span className="text-sm text-emerald-300">
                Catalog looks healthy — {summary.visibleAlavont} Alavont items and {summary.visibleLC} Lucifer Cruz items are visible.
              </span>
            </div>
          )}
        </div>
      )}

      {/* Category Breakdown */}
      {summary && summary.categoryCounts.length > 0 && (
        <div className="glass-card rounded-xl p-4">
          <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">Category Breakdown</div>
          <div className="flex flex-wrap gap-2">
            {summary.categoryCounts.map(({ category, count }) => (
              <div key={category} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-muted/20 border border-border/40 text-xs">
                <Tag size={10} className="text-muted-foreground" />
                <span className="font-medium">{category}</span>
                <span className="text-muted-foreground font-mono">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* WooCommerce Sync Panel */}
      <div className="glass-card rounded-xl p-5 border border-red-500/15">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div>
            <div className="text-sm font-bold flex items-center gap-2">
              <Flame size={14} style={{ color: "#DC143C" }} />
              WooCommerce Sync
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {wooStatus?.configured
                ? `Credentials configured. Store: ${wooStatus.storeUrl}`
                : "No WooCommerce credentials configured. Enter keys below to sync products from the LC store into the local catalog."}
            </div>
          </div>
          {wooStatus?.configured && (
            <span className="text-[10px] px-2 py-1 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold uppercase">Credentials Set</span>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1 block">Store URL</label>
            <Input
              placeholder={wooStatus?.storeUrl ?? "https://lucifercruz.com"}
              value={wcUrl}
              onChange={e => setWcUrl(e.target.value)}
              className="h-9 rounded-xl text-xs bg-background/50"
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1 block">Consumer Key</label>
            <Input
              type="password"
              placeholder="ck_..."
              value={wcKey}
              onChange={e => setWcKey(e.target.value)}
              className="h-9 rounded-xl text-xs bg-background/50"
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1 block">Consumer Secret</label>
            <Input
              type="password"
              placeholder="cs_..."
              value={wcSecret}
              onChange={e => setWcSecret(e.target.value)}
              className="h-9 rounded-xl text-xs bg-background/50"
            />
          </div>
        </div>
        {wcResult && (
          <div className="mb-3 p-3 rounded-xl bg-muted/20 border border-border/40 text-xs font-mono space-y-1">
            <div className="text-emerald-400 font-bold">Sync complete</div>
            <div>Inserted: {wcResult.inserted} | Updated: {wcResult.updated} | Skipped: {wcResult.skipped} | Total: {wcResult.total}</div>
            {wcResult.errors?.length > 0 && (
              <div className="text-red-400">Errors: {wcResult.errors.slice(0, 5).join("; ")}</div>
            )}
          </div>
        )}
        {wooSync.error && (
          <div className="mb-3 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-400">
            {String(wooSync.error)}
          </div>
        )}
        <Button
          size="sm"
          className="rounded-xl text-xs h-9 gap-1.5"
          style={{ background: "linear-gradient(135deg, #DC143C, #8B0000)", color: "#fff", border: "none" }}
          disabled={wooSync.isPending || (!wcKey && !wooStatus?.configured)}
          onClick={() => wooSync.mutate({ storeUrl: wcUrl || undefined, consumerKey: wcKey, consumerSecret: wcSecret })}
        >
          {wooSync.isPending ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />}
          {wooSync.isPending ? "Syncing..." : "Sync WooCommerce Products"}
        </Button>
        {!wcKey && !wooStatus?.configured && (
          <p className="text-[10px] text-muted-foreground mt-2">Enter Consumer Key and Secret to enable sync.</p>
        )}
      </div>

      {/* Product Row Table */}
      <div className="glass-card rounded-xl overflow-hidden">
        <div className="p-4 border-b border-border/40 flex flex-col sm:flex-row gap-3 sm:items-center justify-between">
          <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            Product Rows ({filtered.length} of {allItems.length})
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <div className="relative">
              <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search rows..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-8 h-8 rounded-xl text-xs w-48 bg-background/50"
              />
            </div>
            {(["all", "hidden", "missing"] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-wider border transition-all ${
                  filter === f ? "bg-primary text-primary-foreground border-transparent" : "border-border/40 text-muted-foreground"
                }`}
              >
                {f === "all" ? "All" : f === "hidden" ? "Hidden" : "Missing Fields"}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            <RefreshCw size={20} className="animate-spin mx-auto mb-3" />
            Loading catalog data...
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/30 bg-muted/10">
                  <th className="text-left px-3 py-2 text-muted-foreground font-semibold uppercase tracking-wider w-12">ID</th>
                  <th className="text-left px-3 py-2 text-muted-foreground font-semibold uppercase tracking-wider">Alavont Name</th>
                  <th className="text-left px-3 py-2 text-muted-foreground font-semibold uppercase tracking-wider">LC Name</th>
                  <th className="text-left px-3 py-2 text-muted-foreground font-semibold uppercase tracking-wider">Price</th>
                  <th className="text-left px-3 py-2 text-muted-foreground font-semibold uppercase tracking-wider">Category</th>
                  <th className="text-left px-3 py-2 text-muted-foreground font-semibold uppercase tracking-wider">Lab Name</th>
                  <th className="text-left px-3 py-2 text-muted-foreground font-semibold uppercase tracking-wider">Visibility</th>
                  <th className="text-left px-3 py-2 text-muted-foreground font-semibold uppercase tracking-wider">Issues</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(item => (
                  <tr
                    key={item.id}
                    className={`border-b border-border/20 hover:bg-muted/10 transition-colors ${
                      item.filteredBecause.length > 0 ? "bg-red-500/3" : ""
                    }`}
                  >
                    <td className="px-3 py-2.5 font-mono text-muted-foreground">{item.id}</td>
                    <td className="px-3 py-2.5">
                      {item.alavontName ? (
                        <span className="font-medium">{item.alavontName}</span>
                      ) : (
                        <span className="text-red-400 italic">—missing—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {item.luciferCruzName ? (
                        <span className="text-muted-foreground">{item.luciferCruzName}</span>
                      ) : (
                        <span className="text-amber-500/80 italic">—missing—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {item.regularPrice !== null ? (
                        <span className="font-mono text-emerald-400">${item.regularPrice.toFixed(2)}</span>
                      ) : (
                        <span className="text-red-400 italic">—missing—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {item.alavontCategory ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] bg-muted/30 border border-border/30">
                          {item.alavontCategory}
                        </span>
                      ) : (
                        <span className="text-red-400 italic">—missing—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {item.labName || <span className="text-amber-500/80 italic">—missing—</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-col gap-0.5">
                        <VisibilityBadge visible={item.visibleAlavont} label="Alavont" />
                        <VisibilityBadge visible={item.visibleLC} label="LC" />
                        {!item.hasImage && (
                          <span className="text-[9px] text-muted-foreground flex items-center gap-0.5">
                            <Image size={8} /> no image
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      {item.filteredBecause.length > 0 ? (
                        <div className="space-y-0.5">
                          {item.filteredBecause.map((reason, i) => (
                            <div key={i} className="text-[9px] text-red-400 flex items-start gap-1">
                              <XCircle size={8} className="mt-0.5 shrink-0" /> {reason}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <CheckCircle size={12} className="text-emerald-500/60" />
                      )}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground text-sm">
                      No rows match the current filters
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
