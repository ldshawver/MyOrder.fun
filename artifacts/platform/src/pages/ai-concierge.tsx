import { useState, useRef, useEffect } from "react";
import { useAiConciergeChat, AiChatMessage } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Bot, User, Box } from "lucide-react";
import { Link } from "wouter";

export default function AiConcierge() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<AiChatMessage[]>([
    { role: "assistant", content: "Platform Intelligence initialized. State your query regarding catalog telemetry, order status, or operations." }
  ]);
  const [suggestedItems, setSuggestedItems] = useState<any[]>([]);

  const chatMutation = useAiConciergeChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleSend = () => {
    if (!input.trim() || chatMutation.isPending) return;

    const newMessages = [...messages, { role: "user" as const, content: input }];
    setMessages(newMessages);
    setInput("");

    chatMutation.mutate(
      { data: { messages: newMessages } },
      {
        onSuccess: (res) => {
          setMessages(prev => [...prev, { role: "assistant", content: res.reply }]);
          if (res.suggestedItems && res.suggestedItems.length > 0) {
            setSuggestedItems(res.suggestedItems);
          }
        },
        onError: () => {
          setMessages(prev => [...prev, { role: "assistant", content: "ERR_CONNECTION: Unable to establish link with intelligence core." }]);
        }
      }
    );
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, chatMutation.isPending]);

  return (
    <div className="h-[calc(100vh-6rem)] flex flex-col space-y-4 max-w-7xl mx-auto">
      <div className="shrink-0 pb-4 border-b border-border/50">
        <h1 className="text-3xl font-bold tracking-tight" data-testid="text-title">Intelligence Core</h1>
        <p className="text-muted-foreground text-sm font-mono mt-1">OrderFlow AI Concierge • System Active</p>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 overflow-hidden">
        <Card className="lg:col-span-8 flex flex-col overflow-hidden rounded-sm border-border/50 shadow-sm bg-card">
          <div className="flex-1 overflow-y-auto p-6" ref={scrollRef}>
            <div className="space-y-6">
              {messages.map((m, idx) => (
                <div key={idx} className={`flex gap-4 ${m.role === 'user' ? 'flex-row-reverse' : ''}`} data-testid={`message-${idx}`}>
                  <div className={`w-8 h-8 shrink-0 rounded-sm flex items-center justify-center ${m.role === 'assistant' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                    {m.role === 'assistant' ? <Bot size={16} /> : <User size={16} />}
                  </div>
                  <div className={`max-w-[80%] rounded-sm p-4 ${m.role === 'assistant' ? 'bg-secondary/50 border border-secondary/20 text-secondary-foreground' : 'bg-foreground text-background'}`}>
                    <div className="text-sm whitespace-pre-wrap leading-relaxed font-sans">{m.content}</div>
                  </div>
                </div>
              ))}
              {chatMutation.isPending && (
                <div className="flex gap-4">
                  <div className="w-8 h-8 shrink-0 rounded-sm bg-primary text-primary-foreground flex items-center justify-center">
                    <Bot size={16} />
                  </div>
                  <div className="bg-secondary/50 border border-secondary/20 rounded-sm p-4 flex items-center gap-2">
                    <div className="w-1.5 h-1.5 bg-primary/50 rounded-full animate-pulse" />
                    <div className="w-1.5 h-1.5 bg-primary/50 rounded-full animate-pulse delay-75" />
                    <div className="w-1.5 h-1.5 bg-primary/50 rounded-full animate-pulse delay-150" />
                  </div>
                </div>
              )}
            </div>
          </div>
          
          <div className="p-4 border-t border-border/50 bg-muted/10 shrink-0">
            <form 
              onSubmit={(e) => { e.preventDefault(); handleSend(); }}
              className="flex items-center gap-3"
            >
              <Input 
                value={input} 
                onChange={e => setInput(e.target.value)} 
                placeholder="Query system data..." 
                className="flex-1 rounded-sm border-border bg-background h-12 focus-visible:ring-1 focus-visible:ring-primary"
                data-testid="input-chat"
              />
              <Button type="submit" className="h-12 w-12 rounded-sm" disabled={!input.trim() || chatMutation.isPending} data-testid="button-send">
                <Send size={18} />
              </Button>
            </form>
          </div>
        </Card>

        <Card className="hidden lg:flex lg:col-span-4 flex-col rounded-sm border-border/50 shadow-sm bg-primary/5 border-primary/20">
          <CardHeader className="pb-3 shrink-0 border-b border-primary/10">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider text-primary">Contextual Data</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto p-4">
            {suggestedItems.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-primary/40 space-y-4">
                <Box size={32} className="opacity-20" />
                <div className="text-xs font-mono uppercase tracking-widest text-center">
                  Awaiting Context Parameters
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="text-xs font-mono text-primary/70 uppercase tracking-widest mb-4">Extracted References</div>
                {suggestedItems.map(item => (
                  <div key={item.id} className="bg-background border border-primary/20 p-4 rounded-sm shadow-sm hover:border-primary/40 transition-colors group">
                    <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-1">{item.category}</div>
                    <div className="font-medium text-sm mb-2">{item.name}</div>
                    <div className="flex items-center justify-between mt-3 pt-3 border-t border-primary/10">
                      <div className="text-sm font-mono">${item.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                      <Link href={`/catalog/${item.id}`} className="text-[10px] uppercase font-bold text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                        View Record &rarr;
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
