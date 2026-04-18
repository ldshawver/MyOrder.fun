import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useAiConciergeChat, AiChatMessage, type CatalogItem } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Send, ImageOff, ChevronRight, ChevronLeft, FlaskConical, ShoppingCart, Package, X, RotateCcw } from "lucide-react";
import { Link } from "wouter";

const INTRO_KEY = "hasSeenConciergeIntro_v2";

// ─── Background Particle Field ────────────────────────────────────────────────
const BG_PARTICLES = [
  { id: 0, size: 5,  x: 7,  y: 14, dur: 9,  delay: 0,   color: "rgba(59,130,246,0.4)",  glow: "rgba(59,130,246,0.25)" },
  { id: 1, size: 3,  x: 19, y: 73, dur: 13, delay: 2.1, color: "rgba(139,92,246,0.35)", glow: "rgba(139,92,246,0.2)"  },
  { id: 2, size: 7,  x: 44, y: 28, dur: 10, delay: 4.3, color: "rgba(6,182,212,0.3)",   glow: "rgba(6,182,212,0.18)"  },
  { id: 3, size: 3,  x: 68, y: 84, dur: 7,  delay: 1.2, color: "rgba(245,158,11,0.3)",  glow: "rgba(245,158,11,0.15)" },
  { id: 4, size: 6,  x: 81, y: 22, dur: 11, delay: 3.5, color: "rgba(59,130,246,0.3)",  glow: "rgba(59,130,246,0.15)" },
  { id: 5, size: 2,  x: 14, y: 56, dur: 14, delay: 5.0, color: "rgba(167,139,250,0.4)", glow: "rgba(167,139,250,0.2)" },
  { id: 6, size: 4,  x: 55, y: 62, dur: 8,  delay: 2.7, color: "rgba(6,182,212,0.35)",  glow: "rgba(6,182,212,0.2)"  },
  { id: 7, size: 4,  x: 89, y: 47, dur: 12, delay: 0.8, color: "rgba(59,130,246,0.25)", glow: "rgba(59,130,246,0.12)" },
  { id: 8, size: 6,  x: 33, y: 81, dur: 15, delay: 6.1, color: "rgba(245,158,11,0.2)",  glow: "rgba(245,158,11,0.1)"  },
  { id: 9, size: 2,  x: 72, y: 9,  dur: 9,  delay: 4.2, color: "rgba(139,92,246,0.35)", glow: "rgba(139,92,246,0.2)"  },
  { id: 10, size: 3, x: 50, y: 93, dur: 11, delay: 1.7, color: "rgba(59,130,246,0.3)",  glow: "rgba(59,130,246,0.15)" },
  { id: 11, size: 5, x: 28, y: 38, dur: 8,  delay: 3.3, color: "rgba(6,182,212,0.3)",   glow: "rgba(6,182,212,0.15)"  },
];

function BackgroundField() {
  const shouldReduceMotion = useReducedMotion();
  if (shouldReduceMotion) return null;
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>
      {BG_PARTICLES.map(p => (
        <motion.div
          key={p.id}
          className="absolute rounded-full"
          style={{
            width: p.size,
            height: p.size,
            left: `${p.x}%`,
            top: `${p.y}%`,
            background: p.color,
            boxShadow: `0 0 ${p.size * 4}px ${p.glow}`,
          }}
          animate={{ y: [-18, 18, -18], x: [-10, 10, -10], opacity: [0.35, 1, 0.35], scale: [1, 1.5, 1] }}
          transition={{ duration: p.dur, delay: p.delay, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
}

// ─── Zappy Avatar Components ─────────────────────────────────────────────────
type ZappyMood = "idle" | "thinking" | "speaking";

const MOOD_GLOWS: Record<ZappyMood, { a: string; b: string; ring: string }> = {
  idle:     { a: "rgba(59,130,246,0.7)",  b: "rgba(59,130,246,0.15)",  ring: "#3B82F6" },
  thinking: { a: "rgba(6,182,212,0.7)",   b: "rgba(6,182,212,0.15)",   ring: "#06B6D4" },
  speaking: { a: "rgba(139,92,246,0.75)", b: "rgba(139,92,246,0.15)",  ring: "#8B5CF6" },
};

// Small chat-bubble avatar — icon image in a rounded square with pulsing glow
function ZappyAvatar({ size = 36, mood = "idle" as ZappyMood }: { size?: number; mood?: ZappyMood }) {
  const shouldReduceMotion = useReducedMotion();
  const { a, ring } = MOOD_GLOWS[mood];
  return (
    <motion.div
      className="relative shrink-0 overflow-hidden"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        border: `1px solid ${ring}55`,
        boxShadow: `0 0 ${size * 0.5}px ${a}`,
      }}
      animate={shouldReduceMotion ? {} : {
        boxShadow: [
          `0 0 ${size * 0.5}px ${a}`,
          `0 0 ${size * 0.9}px ${a}`,
          `0 0 ${size * 0.5}px ${a}`,
        ],
      }}
      transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
    >
      <img
        src="/zappy-avatar.png"
        alt="Zappy"
        className="w-full h-full object-cover object-top"
        style={{ filter: "brightness(1.05) contrast(1.05)" }}
      />
    </motion.div>
  );
}

// Large hero avatar — full-body portrait with orbital sparks + float
function ZappyHero({ size = 120, mood = "idle" as ZappyMood }: { size?: number; mood?: ZappyMood }) {
  const shouldReduceMotion = useReducedMotion();
  const { a, b, ring } = MOOD_GLOWS[mood];
  const h = Math.round(size * 1.42);

  return (
    <motion.div
      className="relative shrink-0"
      style={{ width: size, height: h }}
      animate={shouldReduceMotion ? {} : { y: [0, -10, 0] }}
      transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
    >
      {/* Orbital sparks */}
      {!shouldReduceMotion && [
        { delay: "0s",    color: ring,                    size: 8 },
        { delay: "-1.4s", color: "rgba(245,158,11,0.9)", size: 6 },
        { delay: "-2.8s", color: "rgba(167,139,250,0.9)", size: 5 },
      ].map((spark, i) => (
        <div key={i} className="zappy-orbit-wrap" style={{ width: size, height: h, animationDelay: spark.delay }}>
          <div style={{ width: spark.size, height: spark.size, borderRadius: "50%", background: spark.color, boxShadow: `0 0 14px ${spark.color}` }} />
        </div>
      ))}

      {/* Animated outer ring */}
      <motion.div
        className="absolute rounded-2xl pointer-events-none"
        style={{ inset: -5, border: `1px solid ${ring}`, opacity: 0.3 }}
        animate={shouldReduceMotion ? {} : { opacity: [0.15, 0.5, 0.15], scale: [1, 1.02, 1] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* Second outer ring */}
      <motion.div
        className="absolute rounded-3xl pointer-events-none"
        style={{ inset: -14, border: `1px solid ${ring}`, opacity: 0.1 }}
        animate={shouldReduceMotion ? {} : { opacity: [0.05, 0.2, 0.05], scale: [1, 1.03, 1] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut", delay: 0.4 }}
      />

      {/* Image */}
      <div
        className="absolute rounded-2xl overflow-hidden"
        style={{ inset: 0, boxShadow: `0 0 50px ${a}, 0 0 100px ${b}, 0 24px 80px rgba(0,0,0,0.5)` }}
      >
        <img
          src="/zappy-full.png"
          alt="Alavont AI"
          className="w-full h-full object-cover object-top"
          style={{ filter: "brightness(1.08) saturate(1.1)" }}
        />
        {/* Mood-colored energy pulse overlay */}
        <motion.div
          className="absolute inset-0 pointer-events-none"
          style={{ background: `radial-gradient(circle at 50% 30%, ${a} 0%, transparent 65%)`, mixBlendMode: "screen" }}
          animate={shouldReduceMotion ? {} : { opacity: [0, 0.25, 0] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
    </motion.div>
  );
}

// ─── Flash-on-send effect ─────────────────────────────────────────────────────
function SendFlash({ show }: { show: boolean }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="fixed inset-0 pointer-events-none"
          style={{ background: "radial-gradient(circle at center, rgba(59,130,246,0.18) 0%, transparent 70%)", zIndex: 100 }}
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 0.45 }}
        />
      )}
    </AnimatePresence>
  );
}

// ─── Welcome Modal ────────────────────────────────────────────────────────────
const STEPS = [
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

function WelcomeModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const shouldReduceMotion = useReducedMotion();
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];

  function finish() { localStorage.setItem(INTRO_KEY, "true"); onClose(); }

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(5,10,22,0.88)", backdropFilter: "blur(12px)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        className="relative w-full max-w-sm rounded-3xl overflow-hidden"
        style={{
          background: "linear-gradient(160deg, hsl(220 42% 12%), hsl(230 40% 9%))",
          border: "1px solid rgba(59,130,246,0.3)",
          boxShadow: "0 0 80px rgba(59,130,246,0.2), 0 40px 80px rgba(0,0,0,0.7)",
        }}
        initial={shouldReduceMotion ? {} : { scale: 0.7, opacity: 0, y: 40 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 320, damping: 24 }}
      >
        {/* Top glow bar */}
        <motion.div
          className="h-1 w-full"
          style={{ background: `linear-gradient(90deg, transparent, ${MOOD_GLOWS.speaking.a}, transparent)` }}
          animate={{ opacity: [0.6, 1, 0.6] }}
          transition={{ duration: 1.4, repeat: Infinity }}
        />

        <div className="p-7">
          {/* Close */}
          <button
            onClick={finish}
            className="absolute top-4 right-4 w-8 h-8 rounded-xl flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-white/10 transition-all"
          >
            <X size={14} />
          </button>

          {/* Zappy bouncing excitedly */}
          <motion.div
            className="flex justify-center mb-5"
            animate={shouldReduceMotion ? {} : { y: [0, -8, 0] }}
            transition={{ duration: 0.6, repeat: Infinity, ease: "easeInOut" }}
          >
            <ZappyHero size={88} mood="speaking" />
          </motion.div>

          {/* Step content */}
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              className="text-center"
              initial={shouldReduceMotion ? {} : { opacity: 0, scale: 0.92, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={shouldReduceMotion ? {} : { opacity: 0, scale: 1.04, y: -12 }}
              transition={{ duration: 0.22, type: "spring", stiffness: 350 }}
            >
              <div className="text-3xl mb-3">{current.emoji}</div>
              <h2 className="text-xl font-extrabold mb-3 tracking-tight">{current.title}</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">{current.body}</p>
            </motion.div>
          </AnimatePresence>

          {/* Progress dots */}
          <div className="flex justify-center gap-2 mt-6 mb-5">
            {STEPS.map((_, i) => (
              <motion.button
                key={i}
                onClick={() => setStep(i)}
                whileHover={{ scale: 1.4 }}
                whileTap={{ scale: 0.8 }}
              >
                <motion.div
                  className="rounded-full"
                  animate={{ width: i === step ? 24 : 8, background: i === step ? "#60A5FA" : "rgba(96,165,250,0.22)" }}
                  style={{ height: 8 }}
                  transition={{ duration: 0.25 }}
                />
              </motion.button>
            ))}
          </div>

          {/* Buttons */}
          <div className="flex gap-2.5">
            {step > 0 && (
              <motion.button
                onClick={() => setStep(s => s - 1)}
                className="flex-1 h-12 rounded-2xl text-sm font-bold border border-border/40 text-muted-foreground hover:text-foreground hover:border-border/70 flex items-center justify-center gap-1.5 transition-all"
                whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
              >
                <ChevronLeft size={13} /> Back
              </motion.button>
            )}
            <motion.button
              onClick={() => isLast ? finish() : setStep(s => s + 1)}
              className="flex-1 h-12 rounded-2xl font-extrabold text-sm text-white flex items-center justify-center gap-2"
              style={{ background: "linear-gradient(135deg, #3B82F6, #8B5CF6)", boxShadow: "0 4px 24px rgba(139,92,246,0.4)" }}
              whileHover={{ scale: 1.04, boxShadow: "0 6px 32px rgba(139,92,246,0.6)" }}
              whileTap={{ scale: 0.96 }}
            >
              {current.cta}
              {!isLast && <ChevronRight size={14} />}
            </motion.button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Quick action tiles ───────────────────────────────────────────────────────
const ACTIONS = [
  { icon: <FlaskConical size={16} />, label: "Browse Menu", sub: "Explore products", href: "/catalog", color: "from-blue-600/20 to-blue-700/10", border: "border-blue-500/30" },
  { icon: <ShoppingCart size={16} />, label: "New Order", sub: "Start placing", href: "/orders/new", color: "from-purple-600/20 to-purple-700/10", border: "border-purple-500/30" },
  { icon: <Package size={16} />, label: "My Orders", sub: "Track status", href: "/orders", color: "from-cyan-600/20 to-cyan-700/10", border: "border-cyan-500/30" },
];

// ─── Main Page ────────────────────────────────────────────────────────────────
const INITIAL_MSG = `Hey! What's good 👋

I'm Zappy — your personal order concierge. I know the whole menu inside and out.

Ask me what's available, what's popular, need help building an order? I got you. Let's find something great 🛍️`;

const QUICK_PROMPTS = [
  { label: "🔥 What's popular?", q: "What are the most popular products right now?" },
  { label: "🛍️ Show me everything", q: "What products are available today?" },
  { label: "⚡ Build my order", q: "Help me build an order" },
  { label: "💊 How does this work?", q: "Explain how ordering works here" },
];

export default function AiConcierge() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<AiChatMessage[]>([
    { role: "assistant", content: INITIAL_MSG },
  ]);
  const [suggestedItems, setSuggestedItems] = useState<CatalogItem[]>([]);
  const [showIntro, setShowIntro] = useState(() => { try { return !localStorage.getItem(INTRO_KEY); } catch { return false; } });
  const [sendFlash, setSendFlash] = useState(false);
  const [zappyMood, setZappyMood] = useState<ZappyMood>("idle");

  const chatMutation = useAiConciergeChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleSend = useCallback((overrideInput?: string) => {
    const text = overrideInput ?? input;
    if (!text.trim() || chatMutation.isPending) return;
    const newMsgs: AiChatMessage[] = [...messages, { role: "user" as const, content: text }];
    setMessages(newMsgs);
    setInput("");
    setSendFlash(true);
    setTimeout(() => setSendFlash(false), 500);
    setZappyMood("thinking");

    chatMutation.mutate(
      { data: { messages: newMsgs } },
      {
        onSuccess: res => {
          setMessages(prev => [...prev, { role: "assistant" as const, content: res.reply }]);
          if (res.suggestedItems?.length) setSuggestedItems(res.suggestedItems);
          setZappyMood("speaking");
          setTimeout(() => setZappyMood("idle"), 3500);
        },
        onError: () => {
          setMessages(prev => [...prev, { role: "assistant" as const, content: "Ugh, my connection's being weird 😅 Try again in a sec?" }]);
          setZappyMood("idle");
        },
      }
    );
  }, [input, messages, chatMutation]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, chatMutation.isPending]);

  return (
    <>
      <BackgroundField />
      <SendFlash show={sendFlash} />
      <AnimatePresence>
        {showIntro && <WelcomeModal onClose={() => setShowIntro(false)} />}
      </AnimatePresence>

      <div className="relative h-[calc(100dvh-5rem)] flex flex-col gap-3 max-w-6xl mx-auto" style={{ zIndex: 1 }}>

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <motion.div
          className="shrink-0 flex items-center gap-4"
          initial={{ opacity: 0, y: -14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 24 }}
        >
          <ZappyHero size={72} mood={zappyMood} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-black tracking-tight" data-testid="text-title">Zappy</h1>
              <motion.span
                className="text-xs font-bold px-2.5 py-0.5 rounded-full"
                style={{ background: "linear-gradient(135deg, rgba(59,130,246,0.25), rgba(139,92,246,0.2))", border: "1px solid rgba(96,165,250,0.3)", color: "#93C5FD" }}
                animate={{ opacity: [0.8, 1, 0.8] }}
                transition={{ duration: 2, repeat: Infinity }}
              >
                ⚡ ONLINE
              </motion.span>
            </div>
            <div className="text-sm text-muted-foreground mt-0.5 font-medium">Your order concierge · asks no questions, finds anything</div>
          </div>
          <motion.button
            onClick={() => setShowIntro(true)}
            className="shrink-0 h-9 px-3 rounded-xl text-xs font-bold border border-border/40 text-muted-foreground hidden sm:flex items-center gap-1.5"
            whileHover={{ scale: 1.05, borderColor: "rgba(96,165,250,0.4)" }}
            whileTap={{ scale: 0.95 }}
          >
            <RotateCcw size={10} /> Intro
          </motion.button>
        </motion.div>

        {/* ── Content grid ───────────────────────────────────────────────── */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-3 overflow-hidden">

          {/* Chat */}
          <motion.div
            className="lg:col-span-8 rounded-3xl flex flex-col overflow-hidden"
            style={{
              background: "linear-gradient(160deg, hsl(220 38% 10% / 0.97), hsl(225 40% 8% / 0.97))",
              border: "1px solid rgba(59,130,246,0.18)",
              boxShadow: "0 0 60px rgba(59,130,246,0.06), 0 20px 60px rgba(0,0,0,0.4)",
            }}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 22, delay: 0.06 }}
          >
            {/* Messages scroll */}
            <div className="flex-1 overflow-y-auto px-4 py-5 space-y-4" ref={scrollRef}>
              <AnimatePresence initial={false}>
                {messages.map((m, idx) => (
                  <motion.div
                    key={idx}
                    className={`flex gap-3 ${m.role === "user" ? "flex-row-reverse" : ""}`}
                    initial={{ opacity: 0, scale: 0.85, y: 12 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    transition={{ type: "spring", stiffness: 340, damping: 26 }}
                    data-testid={`message-${idx}`}
                  >
                    <div className="shrink-0 mt-0.5">
                      {m.role === "assistant" ? (
                        <ZappyAvatar size={36} mood="idle" />
                      ) : (
                        <div className="w-9 h-9 rounded-2xl flex items-center justify-center" style={{ background: "linear-gradient(135deg, #3B82F6, #8B5CF6)" }}>
                          <div className="w-3 h-3 rounded-full bg-white/70" />
                        </div>
                      )}
                    </div>
                    <div
                      className={`max-w-[80%] rounded-3xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap`}
                      style={m.role === "assistant" ? {
                        background: "linear-gradient(135deg, hsl(220 40% 16%), hsl(220 38% 13%))",
                        border: "1px solid rgba(59,130,246,0.18)",
                        boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
                      } : {
                        background: "linear-gradient(135deg, #3B82F6, #7C3AED)",
                        color: "#fff",
                        boxShadow: "0 6px 24px rgba(59,130,246,0.35)",
                      }}
                    >
                      {m.content}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>

              {/* Typing indicator */}
              <AnimatePresence>
                {chatMutation.isPending && (
                  <motion.div
                    className="flex gap-3"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4 }}
                  >
                    <ZappyAvatar size={36} mood="thinking" />
                    <div
                      className="rounded-3xl px-5 py-4 flex gap-1.5 items-center"
                      style={{ background: "linear-gradient(135deg, hsl(220 40% 16%), hsl(220 38% 13%))", border: "1px solid rgba(6,182,212,0.2)" }}
                    >
                      {[0, 0.18, 0.36].map((d, i) => (
                        <motion.div
                          key={i}
                          className="w-2 h-2 rounded-full"
                          style={{ background: "rgba(6,182,212,0.7)" }}
                          animate={{ y: [0, -7, 0], scale: [1, 1.2, 1] }}
                          transition={{ duration: 0.65, repeat: Infinity, delay: d }}
                        />
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Quick prompts — first message only */}
            <AnimatePresence>
              {messages.length <= 1 && !chatMutation.isPending && (
                <motion.div
                  className="px-4 pb-3 flex flex-wrap gap-2"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                >
                  {QUICK_PROMPTS.map((p, i) => (
                    <motion.button
                      key={p.q}
                      onClick={() => handleSend(p.q)}
                      className="text-xs px-3.5 py-2 rounded-2xl font-semibold border transition-all"
                      style={{ borderColor: "rgba(96,165,250,0.2)", color: "rgba(148,163,184,0.85)", background: "rgba(59,130,246,0.04)" }}
                      initial={{ opacity: 0, scale: 0.85 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: 0.1 + i * 0.07, type: "spring", stiffness: 350 }}
                      whileHover={{ scale: 1.07, borderColor: "rgba(96,165,250,0.55)", background: "rgba(59,130,246,0.1)", color: "#fff" }}
                      whileTap={{ scale: 0.94 }}
                    >
                      {p.label}
                    </motion.button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Input */}
            <div
              className="shrink-0 p-3.5 border-t"
              style={{ borderColor: "rgba(59,130,246,0.12)", background: "rgba(10,16,32,0.5)" }}
            >
              <form onSubmit={e => { e.preventDefault(); handleSend(); }} className="flex gap-2.5">
                <Input
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  placeholder="Ask me anything about the menu..."
                  className="flex-1 rounded-2xl h-12 text-sm bg-white/5 border-border/30 focus:border-primary/60 placeholder:text-muted-foreground/40"
                  data-testid="input-chat"
                />
                <motion.button
                  type="submit"
                  disabled={!input.trim() || chatMutation.isPending}
                  className="h-12 px-5 rounded-2xl font-black text-sm flex items-center gap-2 text-white disabled:opacity-40"
                  style={{ background: "linear-gradient(135deg, #3B82F6, #7C3AED)", boxShadow: "0 4px 20px rgba(59,130,246,0.3)" }}
                  whileHover={input.trim() ? { scale: 1.06, boxShadow: "0 6px 28px rgba(59,130,246,0.55)" } : {}}
                  whileTap={input.trim() ? { scale: 0.93 } : {}}
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
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 22, delay: 0.14 }}
          >
            {/* Quick actions */}
            <div
              className="rounded-3xl p-4"
              style={{ background: "linear-gradient(160deg, hsl(220 38% 10% / 0.95), hsl(225 40% 8% / 0.95))", border: "1px solid rgba(59,130,246,0.16)" }}
            >
              <div className="text-[10px] font-extrabold uppercase tracking-[0.2em] mb-3" style={{ color: "rgba(148,163,184,0.6)" }}>Quick Actions</div>
              <div className="space-y-2">
                {ACTIONS.map((a, i) => (
                  <motion.div key={a.href} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.2 + i * 0.06 }}>
                    <Link
                      href={a.href}
                      className={`flex items-center gap-3 p-3.5 rounded-2xl border bg-gradient-to-r ${a.color} ${a.border} transition-all group`}
                    >
                      <motion.div
                        className="w-9 h-9 rounded-xl flex items-center justify-center text-blue-400"
                        style={{ background: "rgba(59,130,246,0.12)", border: "1px solid rgba(96,165,250,0.25)" }}
                        whileHover={{ rotate: [0, -10, 10, 0], scale: 1.1 }}
                        transition={{ duration: 0.4 }}
                      >
                        {a.icon}
                      </motion.div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-bold">{a.label}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">{a.sub}</div>
                      </div>
                      <ChevronRight size={12} className="text-muted-foreground/30 group-hover:text-primary/60 group-hover:translate-x-0.5 transition-all" />
                    </Link>
                  </motion.div>
                ))}
              </div>
            </div>

            {/* Suggested products */}
            <div
              className="rounded-3xl flex flex-col flex-1 overflow-hidden"
              style={{ background: "linear-gradient(160deg, hsl(220 38% 10% / 0.95), hsl(225 40% 8% / 0.95))", border: "1px solid rgba(59,130,246,0.16)" }}
            >
              <div className="px-4 pt-4 pb-2 shrink-0">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.2em]" style={{ color: "rgba(148,163,184,0.6)" }}>Suggested by Zappy</div>
              </div>
              <div className="flex-1 overflow-y-auto px-3 pb-4">
                {suggestedItems.length === 0 ? (
                  <div className="flex flex-col items-center justify-center text-center py-10">
                    <motion.div
                      animate={{ y: [0, -6, 0] }}
                      transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                    >
                      <ZappyHero size={52} mood="idle" />
                    </motion.div>
                    <p className="text-[11px] text-muted-foreground/50 mt-4 leading-relaxed max-w-[140px]">
                      Ask me what you're looking for and I'll recommend something here
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <AnimatePresence>
                      {suggestedItems.map((item, i) => (
                        <motion.div
                          key={item.id}
                          initial={{ opacity: 0, scale: 0.9, y: 8 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          transition={{ delay: i * 0.06, type: "spring", stiffness: 340 }}
                        >
                          <Link
                            href={`/catalog/${item.id}`}
                            className="flex items-center gap-3 p-2.5 rounded-2xl border border-border/20 hover:border-primary/35 bg-white/3 hover:bg-primary/5 transition-all group"
                          >
                            <div className="w-11 h-11 rounded-xl bg-muted/20 shrink-0 overflow-hidden">
                              {item.imageUrl ? (
                                <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center"><ImageOff size={12} className="text-muted-foreground/20" /></div>
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-widest">{item.category}</div>
                              <div className="text-xs font-bold truncate mt-0.5">{item.name}</div>
                              <div className="text-xs font-black mt-0.5" style={{ color: "#60A5FA" }}>${(+item.price).toFixed(2)}</div>
                            </div>
                          </Link>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                    <Link href="/catalog" className="block text-center text-xs font-bold py-2 mt-1 transition-colors" style={{ color: "rgba(96,165,250,0.7)" }}>
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
