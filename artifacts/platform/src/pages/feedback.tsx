/**
 * User-facing feedback page.
 *
 * Accessible to any authenticated, approved user (customer, CSR, admin).
 * Shows a submission form and the user's own past tickets.
 * Admin-only management features live on /admin/feedback.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Send, ImagePlus, X, MessageSquarePlus } from "lucide-react";

type FeedbackType = "bug" | "ux" | "feature" | "general";
type Severity = "low" | "medium" | "high" | "critical";
type Status = "new" | "reviewed" | "priority_fix" | "in_progress" | "waiting_on_user" | "closed" | "rejected";

const TYPE_OPTIONS: { value: FeedbackType; label: string }[] = [
  { value: "bug", label: "Bug Report" },
  { value: "ux", label: "UX Issue" },
  { value: "feature", label: "Feature Request" },
  { value: "general", label: "General Feedback" },
];

const SEVERITY_OPTIONS: { value: Severity; label: string }[] = [
  { value: "low", label: "Low — minor" },
  { value: "medium", label: "Medium — annoying" },
  { value: "high", label: "High — blocking me" },
  { value: "critical", label: "Critical — data/cash impact" },
];

const STATUS_COLORS: Record<Status, string> = {
  new:              "bg-blue-500/10 text-blue-400 border-blue-500/20",
  reviewed:         "bg-purple-500/10 text-purple-400 border-purple-500/20",
  priority_fix:     "bg-red-500/10 text-red-400 border-red-500/20",
  in_progress:      "bg-amber-500/10 text-amber-400 border-amber-500/20",
  waiting_on_user:  "bg-orange-500/10 text-orange-400 border-orange-500/20",
  closed:           "bg-green-500/10 text-green-400 border-green-500/20",
  rejected:         "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
};

const STATUS_LABELS: Record<Status, string> = {
  new: "New",
  reviewed: "Reviewed",
  priority_fix: "Priority Fix",
  in_progress: "In Progress",
  waiting_on_user: "Waiting on Us",
  closed: "Closed",
  rejected: "Rejected",
};

const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

type Ticket = {
  id: number;
  type: FeedbackType;
  severity: string;
  status: Status;
  title: string;
  createdAt: string;
};

export default function FeedbackPage() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const [location] = useLocation();
  const { toast } = useToast();

  const [type, setType] = useState<FeedbackType>("bug");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [screenshotName, setScreenshotName] = useState<string | null>(null);

  const { data: myTickets, isLoading: ticketsLoading } = useQuery({
    queryKey: ["myFeedback"],
    queryFn: async () => {
      const token = await getToken();
      const res = await fetch("/api/feedback?mine=true", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load tickets");
      return res.json() as Promise<{ tickets: Ticket[]; total: number }>;
    },
  });

  const submitMut = useMutation({
    mutationFn: async () => {
      const token = await getToken();
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          severity,
          title: title.trim(),
          description: description.trim(),
          pageUrl: window.location.href + (location ? "" : ""),
          userAgent: navigator.userAgent.slice(0, 1024),
          screenshotData: screenshot,
        }),
      });
      const body = await res.json() as { id?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Submit failed");
      return body;
    },
    onSuccess: (data) => {
      toast({ title: "Thanks — we got it.", description: `Ticket #${data.id} submitted.` });
      setType("bug");
      setSeverity("medium");
      setTitle("");
      setDescription("");
      setScreenshot(null);
      setScreenshotName(null);
      queryClient.invalidateQueries({ queryKey: ["myFeedback"] });
    },
    onError: (e) => {
      toast({ title: "Submit failed", description: (e as Error).message, variant: "destructive" });
    },
  });

  function handleScreenshot(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_SCREENSHOT_BYTES) {
      toast({ title: "Screenshot too large", description: "Max 2MB. Try cropping or compressing.", variant: "destructive" });
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setScreenshot(reader.result as string);
      setScreenshotName(f.name);
    };
    reader.onerror = () => toast({ title: "Could not read file", variant: "destructive" });
    reader.readAsDataURL(f);
  }

  function handleSubmit() {
    if (title.trim().length < 3) {
      toast({ title: "Add a short title", description: "At least 3 characters.", variant: "destructive" });
      return;
    }
    if (description.trim().length < 5) {
      toast({ title: "Add a description", description: "At least 5 characters.", variant: "destructive" });
      return;
    }
    submitMut.mutate();
  }

  return (
    <div className="space-y-8 max-w-3xl mx-auto">
      <div className="border-b border-border/50 pb-6">
        <h1 className="text-3xl font-bold tracking-tight mb-2 flex items-center gap-3">
          <MessageSquarePlus size={26} className="text-primary" />
          Give Feedback
        </h1>
        <p className="text-muted-foreground">Bug, idea, or rough edge — we want all of it.</p>
      </div>

      {/* Submission form */}
      <div className="bg-card border border-border/50 rounded-sm shadow-sm p-6 space-y-5">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">New Report</h2>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label className="text-xs uppercase tracking-wider">Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as FeedbackType)}>
              <SelectTrigger className="h-9 text-sm mt-1" data-testid="select-feedback-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider">Severity</Label>
            <Select value={severity} onValueChange={(v) => setSeverity(v as Severity)}>
              <SelectTrigger className="h-9 text-sm mt-1" data-testid="select-feedback-severity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEVERITY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <Label className="text-xs uppercase tracking-wider">Title</Label>
          <Input
            className="mt-1"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short summary"
            maxLength={200}
            data-testid="input-feedback-title"
          />
        </div>

        <div>
          <Label className="text-xs uppercase tracking-wider">What happened?</Label>
          <Textarea
            className="mt-1"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={5}
            maxLength={10000}
            placeholder="Steps, expected vs actual, anything useful…"
            data-testid="input-feedback-description"
          />
        </div>

        <div>
          <Label className="text-xs uppercase tracking-wider flex items-center gap-2">
            <ImagePlus size={14} /> Screenshot (optional, max 2MB)
          </Label>
          <input
            type="file"
            accept="image/*"
            onChange={handleScreenshot}
            className="block w-full text-xs text-muted-foreground mt-1 file:mr-3 file:rounded-sm file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-semibold hover:file:bg-muted/70"
            data-testid="input-feedback-screenshot"
          />
          {screenshotName && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate max-w-[80%]">{screenshotName}</span>
              <button
                type="button"
                onClick={() => { setScreenshot(null); setScreenshotName(null); }}
                className="text-red-500 hover:text-red-400"
                aria-label="Remove screenshot"
              >
                <X size={12} />
              </button>
            </div>
          )}
        </div>

        <div className="text-[10px] font-mono text-muted-foreground border-t border-border/30 pt-3">
          We'll auto-capture: this page's URL and your browser/device info.
        </div>

        <div className="flex justify-end">
          <Button
            onClick={handleSubmit}
            disabled={submitMut.isPending}
            className="gap-2"
            data-testid="btn-feedback-submit"
          >
            <Send size={14} />
            {submitMut.isPending ? "Sending…" : "Send Feedback"}
          </Button>
        </div>
      </div>

      {/* Past tickets */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Your Past Reports</h2>
        <div className="bg-card border border-border/50 rounded-sm shadow-sm overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/10">
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Submitted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ticketsLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-20 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : (myTickets?.tickets ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-20 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest">
                    No reports yet.
                  </TableCell>
                </TableRow>
              ) : (myTickets?.tickets ?? []).map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-mono text-xs">{t.id}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="uppercase text-[9px] tracking-widest rounded-sm">{t.type}</Badge>
                  </TableCell>
                  <TableCell className="font-medium text-sm max-w-xs truncate">{t.title}</TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={`uppercase text-[9px] tracking-widest px-2 py-0.5 rounded-sm ${STATUS_COLORS[t.status] ?? ""}`}
                    >
                      {STATUS_LABELS[t.status] ?? t.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground">
                    {new Date(t.createdAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
