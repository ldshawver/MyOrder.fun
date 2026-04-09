import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useAiConciergeChat, AiChatMessage } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Send, ImageOff, ChevronRight, ChevronLeft, FlaskConical, ShoppingCart, Package, X, RotateCcw } from "lucide-react";
import { Link } from "wouter";

const INTRO_KEY = "hasSeenConciergeIntro_v2";

// ─── ConciergeAvatar ──────────────────────────────────────────────────────────
function ConciergeAvatar({ size = 96, speaking = false }: { size?: number; speaking?: boolean }) {
  const shouldReduceMotion = useReducedMotion();
  const r = size / 2;

  return (
    <motion.div
      className="relative flex-shrink-0"
      style={{ width: size, height: size }}
      animate={shouldReduceMotion ? {} : { y: [0, -6, 0] }}
      transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
    >
      {/* Outer electric ring */}
      <motion.div
        className="absolute inset-0 rounded-full"
        style={{
          border: "1.5px dashed rgba(59,130,246,0.45)",
          borderRadius: "50%",
        }}
        animate={shouldReduceMotion ? {} : { rotate: 360 }}
        transition={{ duration: 12, repeat: Infinity, ease: "linear" }}
      />

      {/* Outer glow pulse */}
      <motion.div
        className="absolute rounded-full"
        style={{
          inset: -8,
          background: "radial-gradient(circle, rgba(59,130,246,0.12) 0%, transparent 70%)",
          borderRadius: "50%",
        }}
        animate={shouldReduceMotion ? {} : { scale: [1, 1.15, 1], opacity: [0.6, 1, 0.6] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* Main orb */}
      <div
        className="absolute inset-2 rounded-full"
        style={{
          background: "radial-gradient(circle at 35% 30%, rgba(96,165,250,0.35) 0%, rgba(59,130,246,0.18) 45%, rgba(30,58,138,0.55) 100%)",
          border: "1px solid rgba(96,165,250,0.4)",
          boxShadow: "0 0 24px rgba(59,130,246,0.35), inset 0 1px 1px rgba(255,255,255,0.12)",
          backdropFilter: "blur(4px)",
        }}
      />

      {/* Inner core highlight */}
      <motion.div
        className="absolute rounded-full"
        style={{
          width: size * 0.22,
          height: size * 0.22,
          top: "28%",
          left: "30%",
          background: "radial-gradient(circle, rgba(255,255,255,0.65) 0%, rgba(147,197,253,0.4) 60%, transparent 100%)",
          borderRadius: "50%",
          filter: "blur(1px)",
        }}
        animate={shouldReduceMotion ? {} : { opacity: [0.7, 1, 0.7] }}
        transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* "Eye" dots — gives it personality */}
      <div
        className="absolute flex gap-1.5 items-center justify-center"
        style={{ bottom: "34%", left: 0, right: 0 }}
      >
        <motion.div
          style={{ width: 5, height: 5, borderRadius: "50%", background: "rgba(191,219,254,0.9)" }}
          animate={
            shouldReduceMotion
              ? {}
              : { scaleY: [1, 0.1, 1], opacity: [1, 0.6, 1] }
          }
          transition={{ duration: 4, repeat: Infinity, ease: "easeInOut", times: [0, 0.08, 0.16] }}
        />
        <motion.div
          style={{ width: 5, height: 5, borderRadius: "50%", background: "rgba(191,219,254,0.9)" }}
          animate={
            shouldReduceMotion
              ? {}
              : { scaleY: [1, 0.1, 1], opacity: [1, 0.6, 1] }
          }
          transition={{ duration: 4, repeat: Infinity, ease: "easeInOut", delay: 0.05, times: [0, 0.08, 0.16] }}
        />
      </div>

      {/* Speaking indicator — dots that bounce when assistant types */}
      <AnimatePresence>
        {speaking && (
          <motion.div
            className="absolute -bottom-6 left-1/2 -translate-x-1/2 flex gap-1 items-center"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            {[0, 0.15, 0.3].map((delay, i) => (
              <motion.div
                key={i}
                style={{ width: 4, height: 4, borderRadius: "50%", background: "rgba(96,165,250,0.8)" }}
                animate={{ y: [0, -5, 0] }}
                transition={{ duration: 0.6, repeat: Infinity, delay }}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── FirstTimeWelcomeModal ────────────────────────────────────────────────────
const STEPS = [
  {
    icon: "✦",
    title: "Meet Your Order Concierge",
    body: "Welcome to Alavont Therapeutics. I'm your personal order concierge — here to help you explore the menu, answer product questions, and guide you through the ordering process. Think of me as your knowledgeable, discreet assistant.",
    cta: "Let's go",
  },
  {
    icon: "⬡",
    title: "Browse the Secure Menu",
    body: "All products are available inside the secure catalog. Browse by category, search by name, or ask me to suggest something that fits what you're looking for. Everything in the catalog is curated and ready to order.",
    cta: "Got it",
  },
  {
    icon: "◈",
    title: "Build Your Order & Pay",
    body: "When you're ready, review your cart carefully — double-check quantities and product details. Payment is handled through the approved checkout channel. Take a moment to verify everything before confirming. Accuracy and discretion matter here.",
    cta: "Understood",
  },
  {
    icon: "◎",
    title: "Track Your Fulfillment",
    body: "After checkout, status updates and delivery notifications come straight through this system. No calls needed. When your order is ready, you'll know. You're responsible for reviewing your order details and following any instructions shown at checkout.",
    cta: "I'm ready",
  },
];

function FirstTimeWelcomeModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const shouldReduceMotion = useReducedMotion();
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];

  const handleNext = () => {
    if (isLast) {
      localStorage.setItem(INTRO_KEY, "true");
      onClose();
    } else {
      setStep(s => s + 1);
    }
  };

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(8,15,28,0.85)", backdropFilter: "blur(8px)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        className="relative w-full max-w-md rounded-2xl overflow-hidden"
        style={{
          background: "linear-gradient(145deg, hsl(220 42% 11%), hsl(220 40% 9%))",
          border: "1px solid rgba(59,130,246,0.25)",
          boxShadow: "0 0 60px rgba(59,130,246,0.12), 0 24px 60px rgba(0,0,0,0.6)",
        }}
        initial={shouldReduceMotion ? {} : { scale: 0.92, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 280, damping: 26 }}
      >
        {/* Electric accent bar */}
        <div className="h-0.5 w-full" style={{ background: "linear-gradient(90deg, transparent, rgba(59,130,246,0.6), transparent)" }} />

        <div className="p-8">
          {/* Close */}
          <button
            onClick={() => { localStorage.setItem(INTRO_KEY, "true"); onClose(); }}
            className="absolute top-4 right-4 w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-all"
          >
            <X size={14} />
          </button>

          {/* Avatar */}
          <div className="flex justify-center mb-7">
            <ConciergeAvatar size={80} />
          </div>

          {/* Step content */}
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={shouldReduceMotion ? {} : { opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={shouldReduceMotion ? {} : { opacity: 0, x: -24 }}
              transition={{ duration: 0.22 }}
              className="text-center"
            >
              <div className="text-2xl mb-4" style={{ color: "rgba(96,165,250,0.7)" }}>{current.icon}</div>
              <h2 className="text-lg font-bold mb-3 tracking-tight">{current.title}</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">{current.body}</p>
            </motion.div>
          </AnimatePresence>

          {/* Progress dots */}
          <div className="flex justify-center gap-1.5 mt-7 mb-6">
            {STEPS.map((_, i) => (
              <button key={i} onClick={() => setStep(i)} className="transition-all">
                <div
                  className="rounded-full transition-all duration-300"
                  style={{
                    width: i === step ? 20 : 6,
                    height: 6,
                    background: i === step ? "rgba(96,165,250,0.9)" : "rgba(96,165,250,0.2)",
                  }}
                />
              </button>
            ))}
          </div>

          {/* Navigation */}
          <div className="flex gap-3">
            {step > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="rounded-xl flex-1 h-11 text-xs border-border/40"
                onClick={() => setStep(s => s - 1)}
              >
                <ChevronLeft size={13} className="mr-1" /> Back
              </Button>
            )}
            <button
              onClick={handleNext}
              className="flex-1 h-11 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all"
              style={{
                background: "linear-gradient(135deg, hsl(214 90% 50%), hsl(214 80% 42%))",
                color: "#fff",
                boxShadow: "0 4px 20px rgba(59,130,246,0.35)",
              }}
            >
              {current.cta}
              {!isLast && <ChevronRight size={14} />}
            </button>
          </div>
        </div>

        {/* Bottom accent */}
        <div className="h-0.5 w-full" style={{ background: "linear-gradient(90deg, transparent, rgba(59,130,246,0.2), transparent)" }} />
      </motion.div>
    </motion.div>
  );
}

// ─── QuickActionCard ──────────────────────────────────────────────────────────
function QuickActionCard({ icon, label, sub, href }: { icon: React.ReactNode; label: string; sub: string; href: string }) {
  return (
    <Link
      href={href}
      className="electric-card group flex items-center gap-3 p-3.5 rounded-xl border border-border/30 bg-background/20 hover:bg-primary/5 transition-all hover:-translate-y-0.5"
    >
      <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary/10 border border-primary/20 shrink-0 group-hover:border-primary/40 transition-all">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xs font-bold">{label}</div>
        <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>
      </div>
      <ChevronRight size={12} className="ml-auto text-muted-foreground/40 group-hover:text-primary/60 transition-colors" />
    </Link>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
const INITIAL_MESSAGE = `Welcome to Alavont Therapeutics. I'm your Order Concierge.

I can help you explore the menu, compare products, check pricing, and put together your order. Everything here is handled discreetly and securely.

What can I help you find today?`;

const QUICK_PROMPTS = [
  "What's available today?",
  "What are your best sellers?",
  "Help me build an order",
  "Explain how ordering works",
];

export default function AiConcierge() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<AiChatMessage[]>([
    { role: "assistant", content: INITIAL_MESSAGE },
  ]);
  const [suggestedItems, setSuggestedItems] = useState<any[]>([]);
  const [showIntro, setShowIntro] = useState(() => {
    try { return !localStorage.getItem(INTRO_KEY); } catch { return false; }
  });

  const chatMutation = useAiConciergeChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleSend = useCallback(() => {
    if (!input.trim() || chatMutation.isPending) return;
    const newMessages: AiChatMessage[] = [...messages, { role: "user" as const, content: input }];
    setMessages(newMessages);
    setInput("");

    chatMutation.mutate(
      { data: { messages: newMessages } },
      {
        onSuccess: res => {
          setMessages(prev => [...prev, { role: "assistant" as const, content: res.reply }]);
          if (res.suggestedItems?.length) setSuggestedItems(res.suggestedItems);
        },
        onError: () => {
          setMessages(prev => [
            ...prev,
            { role: "assistant" as const, content: "I'm having trouble connecting right now. Please try again in a moment." },
          ]);
        },
      }
    );
  }, [input, messages, chatMutation]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, chatMutation.isPending]);

  return (
    <>
      <AnimatePresence>
        {showIntro && <FirstTimeWelcomeModal onClose={() => setShowIntro(false)} />}
      </AnimatePresence>

      <div className="h-[calc(100dvh-5rem)] flex flex-col gap-4 max-w-6xl mx-auto">

        {/* ── Hero Header ──────────────────────────────────────────────────── */}
        <motion.div
          className="shrink-0 flex items-center gap-5 pb-4 border-b"
          style={{ borderColor: "rgba(59,130,246,0.15)" }}
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
        >
          <ConciergeAvatar size={68} speaking={chatMutation.isPending} />

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span
                className="text-[9px] font-bold uppercase tracking-[0.25em] px-2 py-0.5 rounded-full border"
                style={{ color: "rgba(96,165,250,0.9)", borderColor: "rgba(59,130,246,0.25)", background: "rgba(59,130,246,0.06)" }}
              >
                Alavont Therapeutics
              </span>
            </div>
            <h1 className="text-xl font-bold tracking-tight" data-testid="text-title">Order Concierge</h1>
            <div className="flex items-center gap-3 mt-0.5">
              <div className="flex items-center gap-1.5 text-[10px] font-mono" style={{ color: "rgba(96,165,250,0.6)" }}>
                <motion.div
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: "rgba(96,165,250,0.8)" }}
                  animate={{ opacity: [1, 0.3, 1] }}
                  transition={{ duration: 1.6, repeat: Infinity }}
                />
                ASSISTANT ONLINE
              </div>
              <span className="text-muted-foreground/30 text-[10px]">·</span>
              <span className="text-[10px] text-muted-foreground/50 font-mono">ENCRYPTED · DISCREET</span>
            </div>
          </div>

          <div className="hidden sm:flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowIntro(true)}
              className="h-8 px-3 rounded-xl text-[10px] font-semibold border border-border/30 text-muted-foreground hover:text-foreground hover:border-border/60 transition-all flex items-center gap-1.5"
              title="Replay intro"
            >
              <RotateCcw size={10} /> Intro
            </button>
          </div>
        </motion.div>

        {/* ── Main content area ─────────────────────────────────────────── */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 overflow-hidden">

          {/* Chat panel */}
          <motion.div
            className="lg:col-span-8 glass-card rounded-2xl flex flex-col overflow-hidden"
            style={{ boxShadow: "0 0 40px rgba(59,130,246,0.04)" }}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.08 }}
          >
            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-5 space-y-4" ref={scrollRef}>
              {messages.map((m, idx) => (
                <motion.div
                  key={idx}
                  className={`flex gap-3 ${m.role === "user" ? "flex-row-reverse" : ""}`}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                  data-testid={`message-${idx}`}
                >
                  {/* Avatar */}
                  <div className="shrink-0 mt-0.5">
                    {m.role === "assistant" ? (
                      <ConciergeAvatar size={32} />
                    ) : (
                      <div className="w-8 h-8 rounded-xl bg-muted/40 border border-border/30 flex items-center justify-center">
                        <div className="w-3 h-3 rounded-full bg-muted-foreground/40" />
                      </div>
                    )}
                  </div>

                  {/* Bubble */}
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                      m.role === "assistant"
                        ? "text-foreground"
                        : "bg-primary text-primary-foreground"
                    }`}
                    style={m.role === "assistant" ? {
                      background: "linear-gradient(135deg, hsl(220 38% 15% / 0.95), hsl(220 38% 12% / 0.95))",
                      border: "1px solid rgba(59,130,246,0.14)",
                      boxShadow: "0 2px 12px rgba(0,0,0,0.2)",
                    } : {
                      boxShadow: "0 4px 16px rgba(59,130,246,0.25)",
                    }}
                  >
                    {m.content}
                  </div>
                </motion.div>
              ))}

              {/* Typing indicator */}
              {chatMutation.isPending && (
                <motion.div
                  className="flex gap-3"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  <div className="shrink-0"><ConciergeAvatar size={32} speaking /></div>
                  <div
                    className="rounded-2xl px-5 py-4 flex gap-1.5 items-center"
                    style={{
                      background: "linear-gradient(135deg, hsl(220 38% 15% / 0.95), hsl(220 38% 12% / 0.95))",
                      border: "1px solid rgba(59,130,246,0.14)",
                    }}
                  >
                    {[0, 150, 300].map(d => (
                      <motion.div
                        key={d}
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ background: "rgba(96,165,250,0.6)" }}
                        animate={{ y: [0, -5, 0] }}
                        transition={{ duration: 0.6, repeat: Infinity, delay: d / 1000 }}
                      />
                    ))}
                  </div>
                </motion.div>
              )}
            </div>

            {/* Quick prompts — only at the start */}
            {messages.length <= 1 && !chatMutation.isPending && (
              <div className="px-4 pb-3 flex flex-wrap gap-2">
                {QUICK_PROMPTS.map(p => (
                  <motion.button
                    key={p}
                    onClick={() => setInput(p)}
                    className="text-xs px-3 py-1.5 rounded-xl border transition-all"
                    style={{ borderColor: "rgba(59,130,246,0.2)", color: "rgba(148,163,184,0.8)" }}
                    whileHover={{ borderColor: "rgba(59,130,246,0.5)", color: "rgba(191,219,254,0.9)", scale: 1.02 }}
                  >
                    {p}
                  </motion.button>
                ))}
              </div>
            )}

            {/* Input bar */}
            <div
              className="shrink-0 p-3.5 border-t"
              style={{ borderColor: "rgba(59,130,246,0.1)", background: "rgba(14,22,40,0.4)" }}
            >
              <form onSubmit={e => { e.preventDefault(); handleSend(); }} className="flex gap-2.5">
                <Input
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  placeholder="Ask about products, pricing, availability..."
                  className="flex-1 rounded-xl h-11 text-sm bg-background/60 border-border/40 focus:border-primary/50"
                  data-testid="input-chat"
                />
                <motion.button
                  type="submit"
                  disabled={!input.trim() || chatMutation.isPending}
                  className="h-11 px-5 rounded-xl font-semibold text-sm flex items-center gap-1.5 transition-all disabled:opacity-40"
                  style={{
                    background: "linear-gradient(135deg, hsl(214 90% 50%), hsl(214 80% 42%))",
                    color: "#fff",
                    boxShadow: input.trim() ? "0 4px 16px rgba(59,130,246,0.35)" : "none",
                  }}
                  whileHover={input.trim() ? { scale: 1.03 } : {}}
                  whileTap={input.trim() ? { scale: 0.97 } : {}}
                  data-testid="button-send"
                >
                  <Send size={14} />
                  Send
                </motion.button>
              </form>
            </div>
          </motion.div>

          {/* Right sidebar */}
          <motion.div
            className="hidden lg:flex lg:col-span-4 flex-col gap-3"
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.35, delay: 0.12 }}
          >
            {/* Quick actions */}
            <div
              className="glass-card rounded-2xl p-4"
              style={{ border: "1px solid rgba(59,130,246,0.12)" }}
            >
              <div className="text-[10px] font-bold uppercase tracking-widest text-primary/60 mb-3">Quick Actions</div>
              <div className="space-y-2">
                <QuickActionCard icon={<FlaskConical size={15} className="text-primary" />} label="Browse Menu" sub="Explore available products" href="/catalog" />
                <QuickActionCard icon={<ShoppingCart size={15} className="text-primary" />} label="New Order" sub="Start placing an order" href="/orders/new" />
                <QuickActionCard icon={<Package size={15} className="text-primary" />} label="My Orders" sub="Track fulfillment status" href="/orders" />
              </div>
            </div>

            {/* Suggested items */}
            <div
              className="glass-card rounded-2xl flex flex-col flex-1 overflow-hidden"
              style={{ border: "1px solid rgba(59,130,246,0.12)" }}
            >
              <div className="px-4 py-3 border-b shrink-0" style={{ borderColor: "rgba(59,130,246,0.1)" }}>
                <div className="text-[10px] font-bold uppercase tracking-widest text-primary/60">Suggested Products</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">Recommended by the assistant</div>
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                {suggestedItems.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center py-8">
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center mb-3"
                      style={{ background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.12)" }}
                    >
                      <FlaskConical size={18} className="text-primary/30" />
                    </div>
                    <div className="text-[11px] text-muted-foreground/50 leading-relaxed">
                      Ask me what you're looking for and I'll recommend products here.
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {suggestedItems.map(item => (
                      <Link
                        key={item.id}
                        href={`/catalog/${item.id}`}
                        className="electric-card flex items-center gap-3 p-2.5 rounded-xl border border-border/20 hover:border-primary/30 bg-background/20 hover:bg-primary/5 transition-all group"
                      >
                        <div className="w-11 h-11 rounded-lg bg-muted/20 shrink-0 overflow-hidden">
                          {item.imageUrl ? (
                            <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center"><ImageOff size={12} className="text-muted-foreground/20" /></div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-widest">{item.category}</div>
                          <div className="text-xs font-semibold truncate mt-0.5">{item.name}</div>
                          <div className="text-xs font-bold text-primary mt-0.5">${parseFloat(item.price).toFixed(2)}</div>
                        </div>
                      </Link>
                    ))}
                    <Link href="/catalog" className="block text-center text-[11px] font-semibold text-primary/70 hover:text-primary py-2 mt-1 transition-colors">
                      Browse full menu →
                    </Link>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </>
  );
}
