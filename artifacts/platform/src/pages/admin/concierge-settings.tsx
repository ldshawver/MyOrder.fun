import { useState, useEffect } from "react";
import { useAuth } from "@clerk/react";
import { Bot, Save, Plus, Trash2, GripVertical, RotateCcw, CheckCircle2, Star, Search, X, ImageOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// ─── Types ────────────────────────────────────────────────────────────────────
type IntroStep = { emoji: string; title: string; body: string; cta: string };
type PromotedItem = { id: number; name: string; category: string; price: number; imageUrl: string | null; isAvailable: boolean };

const DEFAULT_STEPS: IntroStep[] = [
  { emoji: "⚡", title: "Hey! I'm Zappy", body: "Your personal shopping buddy for everything at Alavont & Lucifer Cruz. No judgment, no awkwardness — just me helping you find what you need. I know this menu inside and out.", cta: "Let's go!" },
  { emoji: "🛍️", title: "Explore the Menu", body: "Browse hundreds of products by category or just tell me what you're into. Search it, ask me, or I'll recommend something that fits. We'll find it together.", cta: "Got it, nice!" },
  { emoji: "🛒", title: "Order Like a Pro", body: "Take a quick look at your cart before checking out. Double-check the details — quantities, product names, the works. Once it's in, it's in. No stress though, I got you.", cta: "Sounds good!" },
  { emoji: "📱", title: "Track It & Chill", body: "After checkout, updates come straight here — no calls needed. Sit back, relax. When your order's ready, you'll know. I'll be here if you need anything else.", cta: "I'm ready ⚡" },
];

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const text = await res.text();
  if (!text.trim()) return fallback;
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    return String(body.error ?? body.message ?? fallback);
  } catch {
    return `${fallback} (HTTP ${res.status}): ${text.slice(0, 180)}`;
  }
}

// ─── Featured Panel ────────────────────────────────────────────────────────────
function FeaturedPanel({ token }: { token: string | null }) {
  const [promotedIds, setPromotedIds] = useState<number[]>([]);
  const [catalog, setCatalog] = useState<PromotedItem[]>([]);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch("/api/admin/concierge/promoted", { headers }).then(r => r.json()),
      fetch("/api/catalog?limit=500&mode=alavont", { headers }).then(r => r.json()),
    ]).then(([prom, cat]) => {
      setPromotedIds(prom.ids ?? []);
      const items: PromotedItem[] = (cat.items ?? cat ?? []).map((i: Record<string, unknown>) => ({
        id: i.id,
        name: i.alavontName ?? i.name,
        category: i.alavontCategory ?? i.category,
        price: parseFloat(String(i.price ?? 0)),
        imageUrl: i.alavontImageUrl ?? i.imageUrl ?? null,
        isAvailable: i.isAvailable,
      }));
      setCatalog(items);
    }).catch(() => {}).finally(() => setCatalogLoading(false));
  }, [token]);

  function toggle(id: number) {
    setPromotedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : prev.length < 8 ? [...prev, id] : prev
    );
  }

  async function save() {
    if (!token) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/admin/concierge/promoted", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ids: promotedIds }),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, "Save failed"));
      setSaved(true); setTimeout(() => setSaved(false), 3000);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  const promotedItems = promotedIds.map(id => catalog.find(c => c.id === id)).filter(Boolean) as PromotedItem[];
  const filtered = catalog.filter(c =>
    !promotedIds.includes(c.id) &&
    (c.name.toLowerCase().includes(search.toLowerCase()) || c.category.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            These items always appear in the <span className="text-foreground font-semibold">Suggested by Zappy</span> sidebar for all customers — your curated promo shelf. Up to 8 items. When AI chat returns suggestions those temporarily override.
          </p>
        </div>
        <Button onClick={save} disabled={saving} className="shrink-0 rounded-2xl gap-2" style={{ background: "linear-gradient(135deg, #3B82F6, #7C3AED)" }}>
          {saved ? <><CheckCircle2 size={14} /> Saved!</> : saving ? "Saving…" : <><Save size={14} /> Save</>}
        </Button>
      </div>

      {error && <div className="rounded-2xl px-4 py-3 text-sm text-red-400 border border-red-500/30 bg-red-500/10">{error}</div>}

      {/* Current promo shelf */}
      <div className="rounded-3xl p-4 space-y-2" style={{ background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.2)" }}>
        <div className="text-[10px] font-extrabold uppercase tracking-[0.2em] mb-3" style={{ color: "rgba(148,163,184,0.7)" }}>
          ⭐ Featured shelf ({promotedIds.length}/8)
        </div>
        {promotedItems.length === 0 ? (
          <p className="text-sm text-muted-foreground/50 text-center py-4">No featured items yet — pick from catalog below</p>
        ) : (
          <div className="space-y-2">
            {promotedItems.map(item => (
              <div key={item.id} className="flex items-center gap-3 p-2.5 rounded-2xl bg-white/5 border border-border/20">
                <div className="w-9 h-9 rounded-xl bg-muted/20 shrink-0 overflow-hidden">
                  {item.imageUrl
                    ? <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    : <div className="w-full h-full flex items-center justify-center"><ImageOff size={10} className="text-muted-foreground/20" /></div>}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-widest truncate">{item.category}</div>
                  <div className="text-xs font-bold truncate">{item.name}</div>
                  <div className="text-xs font-black mt-0.5" style={{ color: "#60A5FA" }}>${item.price.toFixed(2)}</div>
                </div>
                <button onClick={() => toggle(item.id)} className="w-7 h-7 rounded-xl flex items-center justify-center text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-all shrink-0">
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Catalog picker */}
      <div className="rounded-3xl p-4 space-y-3" style={{ background: "linear-gradient(160deg, hsl(220 38% 11%), hsl(225 40% 9%))", border: "1px solid rgba(59,130,246,0.18)" }}>
        <div className="text-[10px] font-extrabold uppercase tracking-[0.2em]" style={{ color: "rgba(148,163,184,0.6)" }}>Add from catalog</div>
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/40" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products…" className="pl-8 h-9 rounded-xl bg-white/5 border-border/30 text-sm" />
        </div>
        {catalogLoading ? (
          <div className="flex justify-center py-6"><div className="w-5 h-5 rounded-full border-2 border-primary border-t-transparent animate-spin" /></div>
        ) : (
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {filtered.slice(0, 40).map(item => (
              <button
                key={item.id}
                onClick={() => toggle(item.id)}
                disabled={promotedIds.length >= 8}
                className="w-full flex items-center gap-3 p-2.5 rounded-2xl border border-transparent hover:border-primary/30 hover:bg-white/5 transition-all text-left disabled:opacity-40"
              >
                <div className="w-9 h-9 rounded-xl bg-muted/20 shrink-0 overflow-hidden">
                  {item.imageUrl
                    ? <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    : <div className="w-full h-full flex items-center justify-center"><ImageOff size={10} className="text-muted-foreground/20" /></div>}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-widest truncate">{item.category}</div>
                  <div className="text-xs font-bold truncate">{item.name}</div>
                  <div className="text-xs font-black mt-0.5" style={{ color: "#60A5FA" }}>${item.price.toFixed(2)}</div>
                </div>
                <Plus size={14} className="text-muted-foreground/40 shrink-0" />
              </button>
            ))}
            {filtered.length === 0 && <p className="text-xs text-muted-foreground/40 text-center py-4">No results</p>}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Intro Steps Panel ─────────────────────────────────────────────────────────
function IntroStepsPanel({ token }: { token: string | null }) {
  const [steps, setSteps] = useState<IntroStep[]>(DEFAULT_STEPS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    fetch("/api/admin/concierge-steps", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (Array.isArray(data) && data.length > 0) setSteps(data); })
      .catch(() => {}).finally(() => setLoading(false));
  }, [token]);

  async function save() {
    if (!token) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/admin/concierge-steps", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(steps),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, "Save failed"));
      setSaved(true); setTimeout(() => setSaved(false), 3000);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  function update(i: number, field: keyof IntroStep, val: string) {
    setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, [field]: val } : s));
  }

  if (loading) return <div className="flex justify-center py-12"><div className="w-6 h-6 rounded-full border-2 border-primary border-t-transparent animate-spin" /></div>;

  return (
    <div className="space-y-4">
      {error && <div className="rounded-2xl px-4 py-3 text-sm text-red-400 border border-red-500/30 bg-red-500/10">{error}</div>}
      {steps.map((step, i) => (
        <div key={i} className="rounded-3xl p-5 space-y-3" style={{ background: "linear-gradient(160deg, hsl(220 38% 11%), hsl(225 40% 9%))", border: "1px solid rgba(59,130,246,0.18)" }}>
          <div className="flex items-center gap-2 mb-1">
            <GripVertical size={14} className="text-muted-foreground/40" />
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Step {i + 1}</span>
            <div className="flex-1" />
            {steps.length > 1 && (
              <button onClick={() => setSteps(prev => prev.filter((_, idx) => idx !== i))} className="w-7 h-7 rounded-xl flex items-center justify-center text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-all">
                <Trash2 size={13} />
              </button>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-muted-foreground font-medium mb-1 block">Emoji</label>
              <Input value={step.emoji} onChange={e => update(i, "emoji", e.target.value)} className="text-center text-lg h-10 rounded-xl bg-white/5 border-border/30" maxLength={4} />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground font-medium mb-1 block">Title</label>
              <Input value={step.title} onChange={e => update(i, "title", e.target.value)} className="h-10 rounded-xl bg-white/5 border-border/30" />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground font-medium mb-1 block">Body text</label>
            <textarea value={step.body} onChange={e => update(i, "body", e.target.value)} rows={3} className="w-full rounded-xl bg-white/5 border border-border/30 text-sm px-3 py-2 text-foreground resize-none focus:outline-none focus:border-primary/50" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground font-medium mb-1 block">Button label</label>
            <Input value={step.cta} onChange={e => update(i, "cta", e.target.value)} className="h-10 rounded-xl bg-white/5 border-border/30" />
          </div>
        </div>
      ))}
      <div className="flex gap-3 flex-wrap">
        <Button variant="outline" className="rounded-2xl gap-2" onClick={() => setSteps(prev => [...prev, { emoji: "✨", title: "New Step", body: "", cta: "Got it!" }])} disabled={steps.length >= 8}>
          <Plus size={14} /> Add Step
        </Button>
        <Button variant="outline" className="rounded-2xl gap-2 text-muted-foreground" onClick={() => { if (confirm("Reset to defaults?")) setSteps(DEFAULT_STEPS); }}>
          <RotateCcw size={13} /> Reset defaults
        </Button>
        <div className="flex-1" />
        <Button onClick={save} disabled={saving} className="rounded-2xl gap-2 min-w-[120px]" style={{ background: "linear-gradient(135deg, #3B82F6, #7C3AED)" }}>
          {saved ? <><CheckCircle2 size={14} /> Saved!</> : saving ? "Saving…" : <><Save size={14} /> Save steps</>}
        </Button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function ConciergeSettings() {
  const { getToken } = useAuth();
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => { getToken().then(t => setToken(t)); }, [getToken]);

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-16">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-2xl flex items-center justify-center" style={{ background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.3)" }}>
          <Bot size={18} className="text-blue-400" />
        </div>
        <div>
          <h1 className="text-xl font-black tracking-tight">Zappy Settings</h1>
          <p className="text-sm text-muted-foreground">Manage Zappy's featured shelf and intro experience</p>
        </div>
      </div>

      <Tabs defaultValue="featured">
        <TabsList className="rounded-2xl">
          <TabsTrigger value="featured" className="rounded-xl gap-2"><Star size={13} /> Featured Shelf</TabsTrigger>
          <TabsTrigger value="intro" className="rounded-xl gap-2"><Bot size={13} /> Intro Steps</TabsTrigger>
        </TabsList>
        <TabsContent value="featured" className="mt-5">
          <FeaturedPanel token={token} />
        </TabsContent>
        <TabsContent value="intro" className="mt-5">
          <IntroStepsPanel token={token} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
