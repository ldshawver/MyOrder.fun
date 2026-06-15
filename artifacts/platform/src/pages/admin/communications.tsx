import { useMemo, useState } from "react";
import { BellRing, Building2, Clock3, Headphones, Megaphone, MessageSquare, Phone, Play, Search, ShieldCheck, Voicemail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

const numbers = [
  { id: "num-1", number: "+1 (555) 010-1200", company: "Lucifer Cruz", employee: "Mia R.", status: "active", permissions: "Admin, CSR", sms: true, voice: true },
  { id: "num-2", number: "+1 (555) 010-1201", company: "Lucifer Cruz", employee: null, status: "admin-managed", permissions: "Admin only", sms: true, voice: true },
  { id: "num-3", number: "+1 (555) 010-1202", company: "Alavont", employee: "Shift Queue", status: "active", permissions: "Supervisor, CSR", sms: true, voice: false },
];

const callEvents = [
  { id: "call-101", type: "missed", number: "+1 (555) 010-1200", contact: "Customer", company: "Lucifer Cruz", employee: "Mia R.", time: "Today 10:42 AM", duration: "—" },
  { id: "call-102", type: "received", number: "+1 (555) 010-1201", contact: "Vendor", company: "Lucifer Cruz", employee: "Admin managed", time: "Today 9:18 AM", duration: "4m 12s" },
  { id: "call-103", type: "made", number: "+1 (555) 010-1202", contact: "Courier", company: "Alavont", employee: "Shift Queue", time: "Yesterday 5:06 PM", duration: "1m 36s" },
  { id: "call-104", type: "voicemail", number: "+1 (555) 010-1200", contact: "Customer", company: "Lucifer Cruz", employee: "Mia R.", time: "Yesterday 2:44 PM", duration: "0m 48s" },
];

const voicemails = [
  { id: "vm-1", from: "+1 (555) 700-0199", number: "+1 (555) 010-1200", company: "Lucifer Cruz", assigned: "Mia R.", time: "Today 10:42 AM", length: "0:38", status: "new" },
  { id: "vm-2", from: "+1 (555) 700-0144", number: "+1 (555) 010-1201", company: "Lucifer Cruz", assigned: "Admin managed", time: "Yesterday 2:44 PM", length: "0:48", status: "saved" },
];

export default function AdminCommunications() {
  const [companyFilter, setCompanyFilter] = useState("all");
  const [numberFilter, setNumberFilter] = useState("all");
  const [replyEnabled, setReplyEnabled] = useState(true);
  const [afterHoursForwarding, setAfterHoursForwarding] = useState(true);
  const [campaignName, setCampaignName] = useState("June VIP reorder reminder");

  const filteredNumbers = useMemo(() => numbers.filter((entry) => {
    if (companyFilter !== "all" && entry.company !== companyFilter) return false;
    if (numberFilter !== "all" && entry.number !== numberFilter) return false;
    return true;
  }), [companyFilter, numberFilter]);

  return (
    <div className="max-w-6xl mx-auto space-y-6 p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <MessageSquare size={20} className="text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">SMS & Call Settings</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Manage SMS, auto replies, campaigns, call forwarding, call logs, voicemail, and multi-number permissions.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <Badge variant="secondary">Staging beta · UI-only shell pending communications APIs</Badge>
          <Button className="rounded-xl gap-2"><ShieldCheck size={15} /> Save communication settings</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Select value={companyFilter} onValueChange={setCompanyFilter}>
          <SelectTrigger className="rounded-xl"><SelectValue placeholder="Company" /></SelectTrigger>
          <SelectContent><SelectItem value="all">All companies</SelectItem><SelectItem value="Lucifer Cruz">Lucifer Cruz</SelectItem><SelectItem value="Alavont">Alavont</SelectItem></SelectContent>
        </Select>
        <Select value={numberFilter} onValueChange={setNumberFilter}>
          <SelectTrigger className="rounded-xl"><SelectValue placeholder="Number" /></SelectTrigger>
          <SelectContent><SelectItem value="all">All numbers</SelectItem>{numbers.map(n => <SelectItem key={n.id} value={n.number}>{n.number}</SelectItem>)}</SelectContent>
        </Select>
        <Input className="rounded-xl md:col-span-2" placeholder="Search by customer, employee, company, permission, or number" />
      </div>

      <Tabs defaultValue="sms" className="space-y-4">
        <TabsList className="rounded-xl bg-muted/30 border border-border/40 flex flex-wrap h-auto justify-start">
          <TabsTrigger value="sms" className="rounded-lg text-xs">SMS Settings</TabsTrigger>
          <TabsTrigger value="campaigns" className="rounded-lg text-xs">SMS Campaigns</TabsTrigger>
          <TabsTrigger value="calls" className="rounded-lg text-xs">Call Settings</TabsTrigger>
          <TabsTrigger value="numbers" className="rounded-lg text-xs">Numbers & Permissions</TabsTrigger>
          <TabsTrigger value="log" className="rounded-lg text-xs">Call Log</TabsTrigger>
          <TabsTrigger value="voicemail" className="rounded-lg text-xs">Voicemail</TabsTrigger>
        </TabsList>

        <TabsContent value="sms">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <section className="glass-card rounded-2xl p-5 border border-border/40 space-y-4">
              <div className="flex items-center justify-between"><div><h2 className="text-sm font-semibold uppercase tracking-widest">SMS Settings</h2><p className="text-xs text-muted-foreground mt-1">Defaults apply to every number unless overridden below.</p></div><Switch checked={replyEnabled} onCheckedChange={setReplyEnabled} /></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><Field label="Business hours start" value="09:00" /><Field label="Business hours end" value="19:00" /><Field label="Quiet hours keyword" value="STOP" /><Field label="Fallback owner" value="Admin queue" /></div>
              <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">Default customer reply</Label>
              <Textarea className="rounded-xl min-h-28" defaultValue="Thanks for texting {{company}}. We received your message and a team member will reply shortly." />
            </section>

            <section className="glass-card rounded-2xl p-5 border border-border/40 space-y-4">
              <div><h2 className="text-sm font-semibold uppercase tracking-widest">Auto Reply Rules</h2><p className="text-xs text-muted-foreground mt-1">Auto replies now live on the same page as SMS Settings.</p></div>
              {[
                ["After hours", "Send after-hours message and route urgent texts to the admin-managed inbox."],
                ["Missed call text-back", "Text customers automatically when a call is missed."],
                ["Voicemail received", "Confirm that voicemail was received and give expected response time."],
              ].map(([title, body]) => <div key={title} className="rounded-xl border border-border/40 bg-muted/10 p-3 flex items-start justify-between gap-3"><div><div className="text-sm font-medium">{title}</div><div className="text-xs text-muted-foreground mt-0.5">{body}</div></div><Switch defaultChecked /></div>)}
            </section>
          </div>
        </TabsContent>

        <TabsContent value="campaigns">
          <section className="glass-card rounded-2xl p-5 border border-border/40 space-y-4">
            <div className="flex items-center gap-2"><Megaphone size={17} className="text-primary" /><h2 className="text-sm font-semibold uppercase tracking-widest">SMS Campaigns</h2><Badge variant="secondary" className="ml-auto">Draft safe mode</Badge></div>
            <p className="text-xs text-muted-foreground">Campaigns render locally while recipients, approvals, and Twilio sending are configured, preventing the previous Internal Server Error from blocking the dashboard. This section is intentionally marked UI-only until campaign APIs are connected.</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3"><Field label="Campaign name" value={campaignName} onChange={setCampaignName} /><Field label="Audience" value="Opted-in VIP customers" /><Field label="Sending number" value="Admin-managed default" /></div>
            <Textarea className="rounded-xl min-h-32" defaultValue="Hi {{firstName}}, {{company}} has new arrivals and reorder options ready. Reply HELP for help or STOP to opt out." />
            <div className="flex flex-wrap gap-2"><Button className="rounded-xl">Save Draft</Button><Button variant="outline" className="rounded-xl">Send Test</Button><Button variant="outline" className="rounded-xl">Request Approval</Button></div>
          </section>
        </TabsContent>

        <TabsContent value="calls">
          <section className="glass-card rounded-2xl p-5 border border-border/40 space-y-4">
            <div className="flex items-center justify-between"><div className="flex items-center gap-2"><Phone size={17} className="text-primary" /><h2 className="text-sm font-semibold uppercase tracking-widest">Call Settings</h2></div><Switch checked={afterHoursForwarding} onCheckedChange={setAfterHoursForwarding} /></div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3"><Field label="Timed forwarding starts" value="19:00" /><Field label="Timed forwarding ends" value="09:00" /><Field label="Forward to" value="+1 (555) 010-9999" /></div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Rule icon={Clock3} title="Timed forwarding" body="Route calls to an employee during business hours and to admin-managed coverage after hours." />
              <Rule icon={BellRing} title="Missed call escalation" body="Create a call-log task, send a missed-call SMS, and notify users with permission to manage that number." />
              <Rule icon={Voicemail} title="Voicemail inbox" body="Store voicemail by company, number, employee assignment, and status so admins can triage unassigned messages." />
              <Rule icon={Headphones} title="Playback controls" body="Voicemail rows include listen, save, archive, assign, and callback actions." />
            </div>
          </section>
        </TabsContent>

        <TabsContent value="numbers">
          <section className="glass-card rounded-2xl p-5 border border-border/40 space-y-4">
            <div className="flex items-center gap-2"><Building2 size={17} className="text-primary" /><h2 className="text-sm font-semibold uppercase tracking-widest">Numbers & Permissions</h2></div>
            <p className="text-xs text-muted-foreground">Every number requires a company. Employee assignment is optional; unassigned numbers are admin-managed.</p>
            <div className="overflow-x-auto rounded-xl border border-border/40"><table className="w-full text-sm"><thead className="bg-muted/20 text-xs uppercase tracking-widest text-muted-foreground"><tr><th className="text-left p-3">Number</th><th className="text-left p-3">Company</th><th className="text-left p-3">Employee</th><th className="text-left p-3">Capabilities</th><th className="text-left p-3">Permissions</th></tr></thead><tbody>{filteredNumbers.map(n => <tr key={n.id} className="border-t border-border/30"><td className="p-3 font-mono">{n.number}</td><td className="p-3">{n.company}</td><td className="p-3">{n.employee ?? <span className="text-primary">Admin managed</span>}</td><td className="p-3"><div className="flex gap-1">{n.sms && <Badge>SMS</Badge>}{n.voice && <Badge variant="secondary">Voice</Badge>}</div></td><td className="p-3 text-muted-foreground">{n.permissions}</td></tr>)}</tbody></table></div>
          </section>
        </TabsContent>

        <TabsContent value="log">
          <section className="glass-card rounded-2xl p-5 border border-border/40 space-y-4">
            <div className="flex items-center gap-2"><Search size={17} className="text-primary" /><h2 className="text-sm font-semibold uppercase tracking-widest">Call Log</h2></div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3"><Select defaultValue="all"><SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All calls</SelectItem><SelectItem value="made">Made</SelectItem><SelectItem value="received">Received</SelectItem><SelectItem value="missed">Missed</SelectItem><SelectItem value="voicemail">Voicemails</SelectItem></SelectContent></Select><Input className="rounded-xl md:col-span-3" placeholder="Filter calls by company, number, customer, employee, or status" /></div>
            <div className="space-y-2">{callEvents.map(call => <div key={call.id} className="rounded-xl border border-border/40 bg-muted/10 p-3 flex flex-col md:flex-row md:items-center gap-2 md:gap-4"><Badge variant={call.type === "missed" ? "destructive" : "secondary"} className="w-fit capitalize">{call.type}</Badge><div className="flex-1"><div className="text-sm font-medium">{call.contact} · <span className="font-mono">{call.number}</span></div><div className="text-xs text-muted-foreground">{call.company} · {call.employee} · {call.duration}</div></div><div className="text-xs font-mono text-muted-foreground">{call.time}</div></div>)}</div>
          </section>
        </TabsContent>

        <TabsContent value="voicemail">
          <section className="glass-card rounded-2xl p-5 border border-border/40 space-y-4">
            <div className="flex items-center gap-2"><Voicemail size={17} className="text-primary" /><h2 className="text-sm font-semibold uppercase tracking-widest">Voicemail Inbox</h2></div>
            {voicemails.map(vm => <div key={vm.id} className="rounded-xl border border-border/40 bg-muted/10 p-4 flex flex-col lg:flex-row lg:items-center gap-4"><Button size="icon" className="rounded-full"><Play size={14} /></Button><div className="flex-1"><div className="text-sm font-medium">{vm.from} → <span className="font-mono">{vm.number}</span></div><div className="text-xs text-muted-foreground">{vm.company} · {vm.assigned} · {vm.time} · {vm.length}</div></div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" className="rounded-xl">Assign</Button><Button variant="outline" size="sm" className="rounded-xl">Mark resolved</Button><Button variant="outline" size="sm" className="rounded-xl">Archive</Button></div></div>)}
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange?: (value: string) => void }) {
  return <div className="space-y-1"><Label className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</Label><Input className="rounded-xl" value={value} onChange={event => onChange?.(event.target.value)} readOnly={!onChange} /></div>;
}

function Rule({ icon: Icon, title, body }: { icon: typeof Clock3; title: string; body: string }) {
  return <div className="rounded-xl border border-border/40 bg-muted/10 p-4"><Icon size={16} className="text-primary mb-2" /><div className="text-sm font-medium">{title}</div><div className="text-xs text-muted-foreground mt-1 leading-relaxed">{body}</div></div>;
}
