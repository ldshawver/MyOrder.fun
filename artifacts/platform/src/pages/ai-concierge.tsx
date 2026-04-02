import { useState, useRef, useEffect } from "react";
import { useAiConciergeChat, AiChatMessage } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Send, Bot, User, FlaskConical, Sparkles, ImageOff } from "lucide-react";
import { Link } from "wouter";

export default function AiConcierge() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<AiChatMessage[]>([
    {
      role: "assistant",
      content:
        "Hi! I'm your personal shopping assistant for Alavont Therapeutics. I can help you explore the menu, compare products, check pricing, and put together your order. What can I help you find today?",
    },
  ]);
  const [suggestedItems, setSuggestedItems] = useState<any[]>([]);

  const chatMutation = useAiConciergeChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleSend = () => {
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
  };

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, chatMutation.isPending]);

  const prompts = [
    "What's available today?",
    "What are your best sellers?",
    "Help me build an order",
    "What's the pricing?",
  ];

  return (
    <div className="h-[calc(100vh-6rem)] flex flex-col gap-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="shrink-0 pb-5 border-b border-border/40 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-11 h-11 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <Sparkles size={20} className="text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight" data-testid="text-title">
              AI Shopping Assistant
            </h1>
            <p className="text-xs text-muted-foreground font-mono mt-0.5">
              Alavont Therapeutics · Personalized Service
            </p>
          </div>
        </div>
        <div className="hidden sm:flex items-center gap-1.5 text-[10px] font-mono text-primary/70 px-3 py-1.5 rounded-full border border-primary/20 bg-primary/5">
          <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
          ASSISTANT ONLINE
        </div>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-5 overflow-hidden">
        {/* Chat panel */}
        <div className="lg:col-span-8 glass-card rounded-2xl flex flex-col overflow-hidden">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5" ref={scrollRef}>
            {messages.map((m, idx) => (
              <div
                key={idx}
                className={`flex gap-3 ${m.role === "user" ? "flex-row-reverse" : ""}`}
                data-testid={`message-${idx}`}
              >
                <div
                  className={`w-8 h-8 rounded-xl shrink-0 flex items-center justify-center ${
                    m.role === "assistant"
                      ? "bg-primary/10 border border-primary/20"
                      : "bg-muted/50 border border-border/40"
                  }`}
                >
                  {m.role === "assistant" ? (
                    <Bot size={14} className="text-primary" />
                  ) : (
                    <User size={14} className="text-muted-foreground" />
                  )}
                </div>
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    m.role === "assistant"
                      ? "bg-muted/25 border border-border/30 text-foreground"
                      : "bg-primary text-primary-foreground"
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))}

            {chatMutation.isPending && (
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-xl shrink-0 bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <Bot size={14} className="text-primary" />
                </div>
                <div className="bg-muted/25 border border-border/30 rounded-2xl px-5 py-4 flex gap-2 items-center">
                  {[0, 100, 200].map(d => (
                    <div key={d} className="w-1.5 h-1.5 rounded-full bg-primary/50 animate-pulse" style={{ animationDelay: `${d}ms` }} />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Quick prompts */}
          {messages.length <= 1 && (
            <div className="px-5 pb-3 flex flex-wrap gap-2">
              {prompts.map(p => (
                <button
                  key={p}
                  onClick={() => setInput(p)}
                  className="text-xs px-3 py-1.5 rounded-xl border border-border/40 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-all"
                >
                  {p}
                </button>
              ))}
            </div>
          )}

          {/* Input bar */}
          <div className="shrink-0 p-4 border-t border-border/30 bg-background/10">
            <form onSubmit={e => { e.preventDefault(); handleSend(); }} className="flex gap-3">
              <Input
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="Ask about products, pricing, availability..."
                className="flex-1 rounded-xl h-11 text-sm bg-background/60"
                data-testid="input-chat"
              />
              <Button
                type="submit"
                className="h-11 px-5 rounded-xl font-semibold"
                disabled={!input.trim() || chatMutation.isPending}
                data-testid="button-send"
              >
                <Send size={15} className="mr-1.5" />
                Send
              </Button>
            </form>
          </div>
        </div>

        {/* Sidebar: suggested items */}
        <div className="hidden lg:flex lg:col-span-4 flex-col gap-4">
          <div className="glass-card rounded-2xl flex flex-col overflow-hidden flex-1">
            <div className="px-5 py-4 border-b border-border/30 shrink-0">
              <div className="text-xs font-bold uppercase tracking-wider text-primary">Suggested Products</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">Items the assistant recommends</div>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {suggestedItems.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center py-10">
                  <FlaskConical size={28} className="text-muted-foreground/25 mb-3" />
                  <div className="text-xs text-muted-foreground/50 font-medium">
                    Products recommended by the assistant will appear here
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {suggestedItems.map(item => (
                    <Link
                      key={item.id}
                      href={`/catalog/${item.id}`}
                      className="flex items-center gap-3 p-3 rounded-xl border border-border/30 hover:border-primary/40 bg-background/30 hover:bg-primary/5 transition-all group"
                    >
                      <div className="w-12 h-12 rounded-xl bg-muted/30 shrink-0 overflow-hidden">
                        {item.imageUrl ? (
                          <img
                            src={item.imageUrl}
                            alt={item.name}
                            className="w-full h-full object-cover"
                            onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <ImageOff size={14} className="text-muted-foreground/30" />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">{item.category}</div>
                        <div className="text-sm font-semibold truncate mt-0.5">{item.name}</div>
                        <div className="text-sm font-bold text-primary mt-0.5">${parseFloat(item.price).toFixed(2)}</div>
                      </div>
                    </Link>
                  ))}
                  <Link
                    href="/catalog"
                    className="block text-center text-xs font-semibold text-primary hover:text-primary/80 py-2 mt-2"
                  >
                    Browse full menu →
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
