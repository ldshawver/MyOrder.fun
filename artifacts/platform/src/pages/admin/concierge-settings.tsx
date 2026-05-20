import { useState, useEffect } from "react";
import { useAuth } from "@clerk/react";
import { Bot, Save, Plus, Trash2, GripVertical, RotateCcw, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type IntroStep = {
  emoji: string;
  title: string;
  body: string;
  cta: string;
};

const DEFAULT_STEPS: IntroStep[] = [
  {
    emoji: "⚡",
    title: "Hey! I'm Zappy",
    body: "Your personal shopping buddy for everything at Alavont & Lucifer Cruz. No judgment, no awkwardness — just me helping you find what you need. I know this menu inside and out.",
    cta: "Let's go!",
  },
  {
    emoji: "🛍️",
    title: "Explore the Menu",
    body: "Browse hundreds of products by category or just tell me what you're into. Search it, ask me, or I'll recommend something that fits. We'll find it together.",
    cta: "Got it, nice!",
  },
  {
    emoji: "🛒",
    title: "Order Like a Pro",
    body: "Take a quick look at your cart before checking out. Double-check the details — quantities, product names, the works. Once it's in, it's in. No stress though, I got you.",
    cta: "Sounds good!",
  },
  {
    emoji: "📱",
    title: "Track It & Chill",
    body: "After checkout, updates come straight here — no calls needed. Sit back, relax. When your order's ready, you'll know. I'll be here if you need anything else.",
    cta: "I'm ready ⚡",
  },
];

export default function ConciergeSettings() {
  const { getToken } = useAuth();
  const [steps, setSteps] = useState<IntroStep[]>(DEFAULT_STEPS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken();
        const res = await fetch("/api/admin/concierge-steps", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) setSteps(data);
        }
      } catch {
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [getToken]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/concierge-steps", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(steps),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function update(i: number, field: keyof IntroStep, val: string) {
    setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, [field]: val } : s));
  }

  function addStep() {
    setSteps(prev => [...prev, { emoji: "✨", title: "New Step", body: "", cta: "Got it!" }]);
  }

  function removeStep(i: number) {
    setSteps(prev => prev.filter((_, idx) => idx !== i));
  }

  function resetDefaults() {
    if (confirm("Reset all intro steps to the built-in defaults?")) setSteps(DEFAULT_STEPS);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-16">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-2xl flex items-center justify-center" style={{ background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.3)" }}>
          <Bot size={18} className="text-blue-400" />
        </div>
        <div>
          <h1 className="text-xl font-black tracking-tight">Zappy Intro Steps</h1>
          <p className="text-sm text-muted-foreground">Edit the welcome slides new customers see on first visit</p>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl px-4 py-3 text-sm text-red-400 border border-red-500/30 bg-red-500/10">{error}</div>
      )}

      <div className="space-y-4">
        {steps.map((step, i) => (
          <div
            key={i}
            className="rounded-3xl p-5 space-y-3"
            style={{ background: "linear-gradient(160deg, hsl(220 38% 11%), hsl(225 40% 9%))", border: "1px solid rgba(59,130,246,0.18)" }}
          >
            <div className="flex items-center gap-2 mb-1">
              <GripVertical size={14} className="text-muted-foreground/40" />
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Step {i + 1}</span>
              <div className="flex-1" />
              {steps.length > 1 && (
                <button
                  onClick={() => removeStep(i)}
                  className="w-7 h-7 rounded-xl flex items-center justify-center text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-all"
                >
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
              <textarea
                value={step.body}
                onChange={e => update(i, "body", e.target.value)}
                rows={3}
                className="w-full rounded-xl bg-white/5 border border-border/30 text-sm px-3 py-2 text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:border-primary/50"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground font-medium mb-1 block">Button label</label>
              <Input value={step.cta} onChange={e => update(i, "cta", e.target.value)} className="h-10 rounded-xl bg-white/5 border-border/30" />
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-3 flex-wrap">
        <Button
          variant="outline"
          className="rounded-2xl gap-2"
          onClick={addStep}
          disabled={steps.length >= 8}
        >
          <Plus size={14} /> Add Step
        </Button>
        <Button
          variant="outline"
          className="rounded-2xl gap-2 text-muted-foreground"
          onClick={resetDefaults}
        >
          <RotateCcw size={13} /> Reset to defaults
        </Button>
        <div className="flex-1" />
        <Button
          onClick={save}
          disabled={saving}
          className="rounded-2xl gap-2 min-w-[120px]"
          style={{ background: "linear-gradient(135deg, #3B82F6, #7C3AED)" }}
        >
          {saved ? <><CheckCircle2 size={14} /> Saved!</> : saving ? "Saving…" : <><Save size={14} /> Save steps</>}
        </Button>
      </div>
    </div>
  );
}
