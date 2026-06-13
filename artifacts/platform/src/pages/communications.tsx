import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Phone, MessageSquare, Search, RefreshCw, PhoneCall, Clock, PhoneMissed, Voicemail, Delete, UserRoundCheck } from "lucide-react";

const BASE_API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Health = {
  twilio: { configured: boolean; businessNumber: string | null; voiceConfigured: boolean };
  googleContacts: { oauthConfigured: boolean; connected: boolean; connectedEmail: string | null; lastSyncAt: string | null; lastSyncStatus: string | null; lastSyncError: string | null; cachedContacts: number };
  sms: { threads: number; messages: number };
};

type Contact = { id: number; displayName: string | null; phone: string | null; email: string | null; source: string | null };
type Thread = { id: number; contactPhone: string; contactName: string | null; lastMessageAt: string | null; lastMessagePreview: string | null; unreadCount: number };
type SmsMessage = { id: number; direction: string; fromPhone: string; toPhone: string; body: string; status: string | null; twilioSid: string | null; errorMessage: string | null; createdAt: string | null };
type CallRow = { id: number; contactPhone: string; contactName: string | null; businessNumber: string | null; status: string; provider: string; startedAt: string | null; errorMessage: string | null };

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString([], { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
}

function normalizeDialDisplay(value: string): string {
  return value.replace(/[^+\d]/g, "");
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{subtitle}</p>
    </div>
  );
}

export default function Communications() {
  const { getToken } = useAuth();
  const [health, setHealth] = useState<Health | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<SmsMessage[]>([]);
  const [replyBody, setReplyBody] = useState("");
  const [manualSmsTo, setManualSmsTo] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactQuery, setContactQuery] = useState("");
  const [dialNumber, setDialNumber] = useState("");
  const [recentCalls, setRecentCalls] = useState<CallRow[]>([]);
  const [missedCalls, setMissedCalls] = useState<CallRow[]>([]);
  const [voicemailNote, setVoicemailNote] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const selectedThread = useMemo(() => threads.find(thread => thread.id === selectedThreadId) ?? null, [threads, selectedThreadId]);

  async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
    const token = await getToken();
    const res = await fetch(`${BASE_API}/api${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers ?? {}),
      },
    });
    const text = await res.text();
    const data = (text ? JSON.parse(text) : {}) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    return data as T;
  }

  async function refreshHealth() {
    const data = await api<Health>("/communications/health");
    setHealth(data);
  }

  async function refreshThreads() {
    const data = await api<{ threads: Thread[] }>("/communications/sms/threads");
    setThreads(data.threads);
    if (!selectedThreadId && data.threads[0]) setSelectedThreadId(data.threads[0].id);
  }

  async function refreshCalls() {
    const [recent, missed, voicemail] = await Promise.all([
      api<{ calls: CallRow[] }>("/communications/calls/recent"),
      api<{ calls: CallRow[] }>("/communications/calls/missed"),
      api<{ note: string }>("/communications/voicemail"),
    ]);
    setRecentCalls(recent.calls);
    setMissedCalls(missed.calls);
    setVoicemailNote(voicemail.note);
  }

  async function refreshContacts(q = contactQuery) {
    const data = await api<{ contacts: Contact[] }>(`/communications/contacts?q=${encodeURIComponent(q)}`);
    setContacts(data.contacts);
  }

  async function refreshAll() {
    setLoading(true);
    setStatus(null);
    try {
      await Promise.all([refreshHealth(), refreshThreads(), refreshContacts(), refreshCalls()]);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedThreadId) {
      setMessages([]);
      return;
    }
    api<{ messages: SmsMessage[] }>(`/communications/sms/threads/${selectedThreadId}/messages`)
      .then(data => setMessages(data.messages))
      .then(refreshThreads)
      .catch(err => setStatus(err instanceof Error ? err.message : "Could not load messages"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThreadId]);

  async function connectGoogle() {
    try {
      const data = await api<{ url: string }>("/communications/google/oauth-url");
      window.location.href = data.url;
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Google OAuth failed");
    }
  }

  async function syncGoogle() {
    setLoading(true);
    try {
      const data = await api<{ imported: number }>("/communications/google/sync", { method: "POST", body: JSON.stringify({}) });
      setStatus(`Google Contacts sync completed: ${data.imported} phone records imported.`);
      await Promise.all([refreshHealth(), refreshContacts()]);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Google sync failed");
    } finally {
      setLoading(false);
    }
  }

  async function sendSms() {
    const body = replyBody.trim();
    if (!body) return;
    setLoading(true);
    try {
      await api("/communications/sms/send", {
        method: "POST",
        body: JSON.stringify(selectedThreadId ? { threadId: selectedThreadId, body } : { to: manualSmsTo, body }),
      });
      setReplyBody("");
      await Promise.all([refreshThreads(), selectedThreadId ? api<{ messages: SmsMessage[] }>(`/communications/sms/threads/${selectedThreadId}/messages`).then(data => setMessages(data.messages)) : Promise.resolve()]);
      setStatus("SMS queued through Twilio.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "SMS send failed");
    } finally {
      setLoading(false);
    }
  }

  function appendDigit(digit: string) {
    setDialNumber(prev => normalizeDialDisplay(`${prev}${digit}`));
  }

  async function startCall(to = dialNumber, contactName?: string | null) {
    const normalized = normalizeDialDisplay(to);
    if (!normalized) return;
    setLoading(true);
    try {
      const data = await api<{ status: string; businessNumber: string | null; telHref: string; error?: string }>("/communications/calls", {
        method: "POST",
        body: JSON.stringify({ to: normalized, contactName }),
      });
      setStatus(data.error ? `${data.status}: ${data.error}` : `Call started from ${data.businessNumber ?? "business number"}.`);
      if (data.status === "manual_ready") window.location.href = data.telHref;
      await refreshCalls();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Call failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <SectionHeader title="Business Communications" subtitle="Native SMS replies, Google Contacts lookup, and business-number calling." />
        <Button variant="outline" onClick={refreshAll} disabled={loading} className="gap-2">
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} /> Refresh
        </Button>
      </div>

      {status && <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">{status}</div>}

      <div className="grid gap-3 md:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs uppercase text-muted-foreground">Twilio SMS</div>
            <Badge variant={health?.twilio.configured ? "default" : "secondary"}>{health?.twilio.configured ? "Configured" : "Missing config"}</Badge>
            <div className="mt-2 text-xs font-mono break-words">{health?.twilio.businessNumber ?? "No business number"}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs uppercase text-muted-foreground">Google Contacts</div>
            <Badge variant={health?.googleContacts.connected ? "default" : "secondary"}>{health?.googleContacts.connected ? "Connected" : "Not connected"}</Badge>
            <div className="mt-2 text-xs text-muted-foreground">{health?.googleContacts.cachedContacts ?? 0} cached phone records</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs uppercase text-muted-foreground">SMS Threads</div>
            <div className="text-2xl font-semibold">{health?.sms.threads ?? threads.length}</div>
            <div className="text-xs text-muted-foreground">{health?.sms.messages ?? messages.length} messages tracked</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs uppercase text-muted-foreground">Voice</div>
            <Badge variant={health?.twilio.voiceConfigured ? "default" : "secondary"}>{health?.twilio.voiceConfigured ? "Native Twilio" : "Manual fallback"}</Badge>
            <div className="mt-2 text-xs text-muted-foreground">Outbound caller ID uses the assigned business number.</div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="sms">
        <TabsList className="grid grid-cols-3 md:w-[520px]">
          <TabsTrigger value="sms" className="gap-2"><MessageSquare size={14} /> SMS</TabsTrigger>
          <TabsTrigger value="phone" className="gap-2"><Phone size={14} /> Phone</TabsTrigger>
          <TabsTrigger value="contacts" className="gap-2"><UserRoundCheck size={14} /> Contacts</TabsTrigger>
        </TabsList>

        <TabsContent value="sms" className="mt-4 grid gap-4 lg:grid-cols-[340px_1fr]">
          <Card className="overflow-hidden">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Conversation Threads</CardTitle>
            </CardHeader>
            <CardContent className="p-0 divide-y divide-border">
              {threads.map(thread => (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => setSelectedThreadId(thread.id)}
                  className={`w-full text-left p-3 hover:bg-muted/60 ${selectedThreadId === thread.id ? "bg-primary/10" : ""}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium truncate">{thread.contactName ?? thread.contactPhone}</div>
                    {thread.unreadCount > 0 && <Badge>{thread.unreadCount}</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground font-mono truncate">{thread.contactPhone}</div>
                  <div className="text-xs text-muted-foreground truncate mt-1">{thread.lastMessagePreview}</div>
                </button>
              ))}
              {threads.length === 0 && <div className="p-4 text-sm text-muted-foreground">No SMS threads yet. Search a contact or enter a number to start one.</div>}
            </CardContent>
          </Card>

          <Card className="min-h-[620px] flex flex-col">
            <CardHeader>
              <CardTitle className="text-base">{selectedThread ? (selectedThread.contactName ?? selectedThread.contactPhone) : "New SMS"}</CardTitle>
              {selectedThread && <div className="text-xs text-muted-foreground font-mono">{selectedThread.contactPhone}</div>}
            </CardHeader>
            <CardContent className="flex-1 flex flex-col gap-3">
              {!selectedThread && (
                <Input placeholder="Manual number, e.g. +14155551212" value={manualSmsTo} onChange={e => setManualSmsTo(e.target.value)} />
              )}
              <div className="flex-1 rounded-md border border-border bg-muted/20 p-3 overflow-y-auto space-y-3">
                {messages.map(message => (
                  <div key={message.id} className={`flex ${message.direction === "outbound" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words leading-relaxed ${message.direction === "outbound" ? "bg-primary text-primary-foreground" : "bg-background border border-border"}`}>
                      {message.body}
                      <div className={`mt-1 text-[10px] ${message.direction === "outbound" ? "text-primary-foreground/70" : "text-muted-foreground"}`}>{formatDate(message.createdAt)} · {message.status ?? "recorded"}</div>
                    </div>
                  </div>
                ))}
                {messages.length === 0 && <div className="text-sm text-muted-foreground">Select a thread or type a number and send a message.</div>}
              </div>
              <div className="space-y-2">
                <Textarea
                  placeholder="Type a normal reply — no command syntax required."
                  value={replyBody}
                  onChange={e => setReplyBody(e.target.value)}
                  onKeyDown={e => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void sendSms();
                  }}
                  className="min-h-24 whitespace-pre-wrap"
                />
                <Button onClick={sendSms} disabled={loading || !replyBody.trim() || (!selectedThread && !manualSmsTo.trim())} className="w-full md:w-auto">Send</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="phone" className="mt-4 grid gap-4 lg:grid-cols-[360px_1fr]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Dial Pad</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input value={dialNumber} onChange={e => setDialNumber(normalizeDialDisplay(e.target.value))} placeholder="Manual number entry" className="text-center text-xl font-mono" />
              <div className="grid grid-cols-3 gap-2">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9", "+", "0", "#"].map(digit => (
                  <Button key={digit} variant="outline" className="h-12 text-lg" onClick={() => appendDigit(digit)}>{digit}</Button>
                ))}
              </div>
              <div className="flex gap-2">
                <Button className="flex-1 gap-2" onClick={() => startCall()} disabled={!dialNumber || loading}><PhoneCall size={16} /> Call</Button>
                <Button variant="outline" onClick={() => setDialNumber(prev => prev.slice(0, -1))}><Delete size={16} /></Button>
              </div>
              <div className="text-xs text-muted-foreground">Native calls use Twilio Voice when configured. If voice webhooks are missing, the app logs the attempt and opens the device dialer as a fallback.</div>
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-base flex items-center gap-2"><Search size={16} /> Contact Search</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Input value={contactQuery} onChange={e => setContactQuery(e.target.value)} placeholder="Search Google Contacts cache" />
                  <Button variant="outline" onClick={() => refreshContacts()}>Search</Button>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {contacts.slice(0, 8).map(contact => (
                    <div key={contact.id} className="rounded-md border border-border p-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium truncate">{contact.displayName ?? contact.phone}</div>
                        <div className="text-xs text-muted-foreground font-mono truncate">{contact.phone}</div>
                      </div>
                      <Button size="sm" onClick={() => startCall(contact.phone ?? "", contact.displayName)} disabled={!contact.phone}>Call</Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Clock size={14} /> Recent Calls</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {recentCalls.slice(0, 6).map(call => <CallListItem key={call.id} call={call} />)}
                  {recentCalls.length === 0 && <div className="text-xs text-muted-foreground">No recent calls.</div>}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><PhoneMissed size={14} /> Missed Calls</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {missedCalls.slice(0, 6).map(call => <CallListItem key={call.id} call={call} />)}
                  {missedCalls.length === 0 && <div className="text-xs text-muted-foreground">No missed calls.</div>}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Voicemail size={14} /> Voicemail</CardTitle></CardHeader>
                <CardContent><div className="text-xs text-muted-foreground">{voicemailNote || "No voicemail messages."}</div></CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="contacts" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Google Contacts Integration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-md border border-border p-3">
                  <div className="text-xs uppercase text-muted-foreground">OAuth Connection</div>
                  <div className="font-medium">{health?.googleContacts.connected ? "Connected" : "Not connected"}</div>
                  <div className="text-xs text-muted-foreground break-words">{health?.googleContacts.connectedEmail ?? "Connect to Google to populate the cache."}</div>
                </div>
                <div className="rounded-md border border-border p-3">
                  <div className="text-xs uppercase text-muted-foreground">Sync Job</div>
                  <div className="font-medium">{health?.googleContacts.lastSyncStatus ?? "Never run"}</div>
                  <div className="text-xs text-muted-foreground">Last sync: {formatDate(health?.googleContacts.lastSyncAt ?? null)}</div>
                </div>
                <div className="rounded-md border border-border p-3">
                  <div className="text-xs uppercase text-muted-foreground">Contact Cache</div>
                  <div className="font-medium">{health?.googleContacts.cachedContacts ?? 0} records</div>
                  <div className="text-xs text-muted-foreground">Incoming SMS names resolve from this cache.</div>
                </div>
              </div>
              {health?.googleContacts.lastSyncError && <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">{health.googleContacts.lastSyncError}</div>}
              <div className="flex flex-wrap gap-2">
                <Button onClick={connectGoogle} disabled={!health?.googleContacts.oauthConfigured}>Connect Google Contacts</Button>
                <Button variant="outline" onClick={syncGoogle} disabled={!health?.googleContacts.connected || loading}>Run Sync Job</Button>
              </div>
              <div className="flex gap-2">
                <Input value={contactQuery} onChange={e => setContactQuery(e.target.value)} placeholder="Search cached contacts by name, phone, or email" />
                <Button variant="outline" onClick={() => refreshContacts()}>Search</Button>
              </div>
              <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                {contacts.map(contact => (
                  <div key={contact.id} className="rounded-md border border-border p-3">
                    <div className="font-medium break-words">{contact.displayName ?? "Unnamed contact"}</div>
                    <div className="text-xs font-mono text-muted-foreground break-words">{contact.phone ?? "No phone"}</div>
                    <div className="text-xs text-muted-foreground break-words">{contact.email}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CallListItem({ call }: { call: CallRow }) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="text-sm font-medium truncate">{call.contactName ?? call.contactPhone}</div>
      <div className="text-[11px] text-muted-foreground font-mono truncate">{call.contactPhone}</div>
      <div className="text-[11px] text-muted-foreground">{call.status} · {formatDate(call.startedAt)}</div>
    </div>
  );
}
