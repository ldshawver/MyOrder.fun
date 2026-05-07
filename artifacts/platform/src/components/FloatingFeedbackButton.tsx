/**
 * Floating "Feedback" button + modal for the authenticated app.
 *
 * Mounted once inside <Layout>. The button sits in the bottom-right corner
 * (above the mobile bottom-tab bar) and opens a modal with a single short
 * form. Browser metadata + the current page URL are captured automatically
 * so the user only fills in the qualitative bits.
 *
 * Screenshot upload is optional and stored as a base64 data URL inline on
 * the ticket row (capped at ~2MB to match the API). For v1 this trades
 * "no extra dependencies" for "screenshots cost a few KB per ticket in
 * the DB" — fine for the volume an internal team generates.
 */
import { useState } from "react";
import { useAuth } from "@clerk/react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { MessageSquarePlus, Send, X, ImagePlus } from "lucide-react";

type FeedbackType = "bug" | "ux" | "feature" | "general";
type Severity = "low" | "medium" | "high" | "critical";

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

const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

export function FloatingFeedbackButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed z-40 bottom-24 md:bottom-6 right-4 md:right-6 h-12 px-4 rounded-full bg-primary text-primary-foreground font-semibold text-xs uppercase tracking-wider shadow-lg shadow-primary/30 hover:scale-105 active:scale-95 transition-transform flex items-center gap-2"
        data-testid="btn-floating-feedback"
        aria-label="Send feedback"
      >
        <MessageSquarePlus size={16} />
        <span className="hidden sm:inline">Feedback</span>
      </button>
      <FeedbackModal open={open} onOpenChange={setOpen} />
    </>
  );
}

function FeedbackModal({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { getToken } = useAuth();
  const [location] = useLocation();
  const { toast } = useToast();

  const [type, setType] = useState<FeedbackType>("bug");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [screenshotName, setScreenshotName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setType("bug");
    setSeverity("medium");
    setTitle("");
    setDescription("");
    setScreenshot(null);
    setScreenshotName(null);
  }

  async function handleScreenshot(e: React.ChangeEvent<HTMLInputElement>) {
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
    reader.onerror = () => {
      toast({ title: "Could not read file", variant: "destructive" });
    };
    reader.readAsDataURL(f);
  }

  async function handleSubmit() {
    if (title.trim().length < 3) {
      toast({ title: "Add a short title", description: "At least 3 characters.", variant: "destructive" });
      return;
    }
    if (description.trim().length < 5) {
      toast({ title: "Add a description", description: "At least 5 characters.", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const token = await getToken();
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          severity,
          title: title.trim(),
          description: description.trim(),
          // Auto-captured context — the user doesn't see or edit this.
          pageUrl: window.location.href + (location ? "" : ""),
          userAgent: navigator.userAgent.slice(0, 1024),
          screenshotData: screenshot,
        }),
      });
      const body = await res.json() as { id?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Submit failed");
      toast({ title: "Thanks — we got it.", description: `Ticket #${body.id} submitted.` });
      reset();
      onOpenChange(false);
    } catch (e) {
      toast({ title: "Submit failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!submitting) onOpenChange(v); }}>
      <DialogContent className="max-w-lg" data-testid="modal-feedback">
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>
            Bug, idea, or rough edge — we want all of it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider">Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as FeedbackType)}>
                <SelectTrigger className="h-9 text-sm" data-testid="select-feedback-type">
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
                <SelectTrigger className="h-9 text-sm" data-testid="select-feedback-severity">
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

          <div className="text-[10px] font-mono text-muted-foreground border-t border-border/30 pt-2">
            We'll auto-capture: this page's URL and your browser/device info.
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting} data-testid="btn-feedback-cancel">
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting} className="gap-2" data-testid="btn-feedback-submit">
            <Send size={14} />
            {submitting ? "Sending…" : "Send"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
