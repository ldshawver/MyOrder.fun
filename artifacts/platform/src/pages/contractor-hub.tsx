import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { useLocation } from "wouter";
import type { UserProfile } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  FileText,
  ReceiptText,
  LayoutTemplate,
  Plus,
  Copy,
  Eye,
  Sparkles,
  Lock,
  Layers,
  FilePlus,
  ChevronRight,
  Trash2,
} from "lucide-react";

const BASE_API = import.meta.env.BASE_URL.replace(/\/$/, "");

type LineItem = {
  description: string;
  quantity: number;
  unit: string;
  rate: number;
  amount: number;
};

type ContractorTemplate = {
  id: number;
  companyId: number | null;
  name: string;
  templateType: "proposal" | "invoice";
  styleLevel: "minimal" | "standard" | "detailed" | "branded";
  description: string | null;
  workType: string | null;
  pricingStructure: string | null;
  defaultScope: string | null;
  defaultTerms: string | null;
  defaultPaymentTerms: string | null;
  defaultNotes: string | null;
  defaultLineItems: LineItem[] | null;
  brandingEnabled: boolean;
  isDefault: boolean;
  isPlatformDefault: boolean;
  isActive: boolean;
};

type Proposal = {
  id: number;
  title: string;
  status: string;
  clientName: string | null;
  clientCompany: string | null;
  total: string | null;
  updatedAt: string;
};

type Invoice = {
  id: number;
  title: string;
  status: string;
  invoiceNumber: string | null;
  clientName: string | null;
  total: string | null;
  balanceDue: string | null;
  dueDate: string | null;
  updatedAt: string;
};

const STYLE_ORDER: ContractorTemplate["styleLevel"][] = ["minimal", "standard", "detailed", "branded"];
const STYLE_LABELS: Record<ContractorTemplate["styleLevel"], string> = {
  minimal: "Minimal", standard: "Standard", detailed: "Detailed", branded: "Branded",
};
const STYLE_DESCS: Record<ContractorTemplate["styleLevel"], string> = {
  minimal: "Simple and fast", standard: "Complete and professional",
  detailed: "Comprehensive for complex work", branded: "Polished with your brand",
};

const PROPOSAL_STATUS_COLORS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "secondary", sent: "default", accepted: "default", rejected: "destructive", expired: "outline",
};
const INVOICE_STATUS_COLORS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "secondary", sent: "default", paid: "default", overdue: "destructive", voided: "outline",
};

function authFetch(token: string | null, input: string, init?: RequestInit) {
  return fetch(input, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

// ─── Proposals Tab ────────────────────────────────────────────────────────────
function ProposalsTab({ user }: { user: UserProfile }) {
  const { getToken } = useAuth();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ["contractor-proposals"],
    queryFn: async () => {
      const token = await getToken();
      const res = await authFetch(token, `${BASE_API}/api/contractor-hub/proposals`);
      if (!res.ok) throw new Error("Failed");
      const d = await res.json() as { proposals: Proposal[] };
      return d.proposals;
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const token = await getToken();
      const res = await authFetch(token, `${BASE_API}/api/contractor-hub/proposals/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contractor-proposals"] });
      toast({ title: "Proposal deleted" });
    },
  });

  const canManage = user.role === "admin" || user.role === "supervisor" || user.role === "business_sitter";

  if (isLoading) {
    return <div className="space-y-3">{[1, 2, 3].map(i => <div key={i} className="h-16 bg-muted/40 rounded-lg animate-pulse" />)}</div>;
  }

  const proposals = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{proposals.length} proposal{proposals.length !== 1 ? "s" : ""}</p>
        {canManage && (
          <Button size="sm" className="gap-1.5" onClick={() => setLocation("/contractor-hub/proposals/new")}>
            <Plus className="w-4 h-4" /> New Proposal
          </Button>
        )}
      </div>

      {proposals.length === 0 ? (
        <div className="border border-dashed rounded-xl py-16 text-center">
          <FileText className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
          <div className="text-sm font-medium text-muted-foreground">No proposals yet</div>
          {canManage && (
            <Button variant="outline" size="sm" className="mt-4 gap-1.5" onClick={() => setLocation("/contractor-hub/proposals/new")}>
              <Plus className="w-4 h-4" /> Create your first proposal
            </Button>
          )}
        </div>
      ) : (
        <div className="border rounded-lg divide-y">
          {proposals.map(p => (
            <div
              key={p.id}
              className="flex items-center gap-3 px-4 py-3 hover:bg-muted/20 cursor-pointer group"
              onClick={() => setLocation(`/contractor-hub/proposals/${p.id}`)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm truncate">{p.title}</span>
                  <Badge variant={PROPOSAL_STATUS_COLORS[p.status] ?? "outline"} className="text-xs capitalize shrink-0">
                    {p.status}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5 truncate">
                  {p.clientName ?? "No client"}{p.clientCompany ? ` · ${p.clientCompany}` : ""}
                </div>
              </div>
              {p.total && (
                <div className="text-sm font-medium tabular-nums shrink-0">${parseFloat(p.total).toFixed(2)}</div>
              )}
              <div className="text-xs text-muted-foreground shrink-0">
                {new Date(p.updatedAt).toLocaleDateString()}
              </div>
              {canManage && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                  onClick={e => { e.stopPropagation(); deleteMutation.mutate(p.id); }}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              )}
              <ChevronRight className="w-4 h-4 text-muted-foreground/40 shrink-0" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Invoices Tab ─────────────────────────────────────────────────────────────
function InvoicesTab({ user }: { user: UserProfile }) {
  const { getToken } = useAuth();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ["contractor-invoices"],
    queryFn: async () => {
      const token = await getToken();
      const res = await authFetch(token, `${BASE_API}/api/contractor-hub/invoices`);
      if (!res.ok) throw new Error("Failed");
      const d = await res.json() as { invoices: Invoice[] };
      return d.invoices;
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const token = await getToken();
      const res = await authFetch(token, `${BASE_API}/api/contractor-hub/invoices/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contractor-invoices"] });
      toast({ title: "Invoice deleted" });
    },
  });

  const canManage = user.role === "admin" || user.role === "supervisor" || user.role === "business_sitter";

  if (isLoading) {
    return <div className="space-y-3">{[1, 2, 3].map(i => <div key={i} className="h-16 bg-muted/40 rounded-lg animate-pulse" />)}</div>;
  }

  const invoices = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{invoices.length} invoice{invoices.length !== 1 ? "s" : ""}</p>
        {canManage && (
          <Button size="sm" className="gap-1.5" onClick={() => setLocation("/contractor-hub/invoices/new")}>
            <Plus className="w-4 h-4" /> New Invoice
          </Button>
        )}
      </div>

      {invoices.length === 0 ? (
        <div className="border border-dashed rounded-xl py-16 text-center">
          <ReceiptText className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
          <div className="text-sm font-medium text-muted-foreground">No invoices yet</div>
          {canManage && (
            <Button variant="outline" size="sm" className="mt-4 gap-1.5" onClick={() => setLocation("/contractor-hub/invoices/new")}>
              <Plus className="w-4 h-4" /> Create your first invoice
            </Button>
          )}
        </div>
      ) : (
        <div className="border rounded-lg divide-y">
          {invoices.map(inv => (
            <div
              key={inv.id}
              className="flex items-center gap-3 px-4 py-3 hover:bg-muted/20 cursor-pointer group"
              onClick={() => setLocation(`/contractor-hub/invoices/${inv.id}`)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {inv.invoiceNumber && <span className="text-xs text-muted-foreground font-mono shrink-0">{inv.invoiceNumber}</span>}
                  <span className="font-medium text-sm truncate">{inv.title}</span>
                  <Badge variant={INVOICE_STATUS_COLORS[inv.status] ?? "outline"} className="text-xs capitalize shrink-0">
                    {inv.status}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5 truncate">
                  {inv.clientName ?? "No client"}{inv.dueDate ? ` · Due ${new Date(inv.dueDate).toLocaleDateString()}` : ""}
                </div>
              </div>
              {inv.balanceDue && (
                <div className="text-sm font-medium tabular-nums shrink-0">
                  ${parseFloat(inv.balanceDue).toFixed(2)} due
                </div>
              )}
              <div className="text-xs text-muted-foreground shrink-0">
                {new Date(inv.updatedAt).toLocaleDateString()}
              </div>
              {canManage && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                  onClick={e => { e.stopPropagation(); deleteMutation.mutate(inv.id); }}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              )}
              <ChevronRight className="w-4 h-4 text-muted-foreground/40 shrink-0" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Templates Tab ────────────────────────────────────────────────────────────
function useTemplates(type: "proposal" | "invoice") {
  const { getToken } = useAuth();
  return useQuery({
    queryKey: ["contractor-templates", type],
    queryFn: async () => {
      const token = await getToken();
      const res = await authFetch(token, `${BASE_API}/api/contractor-hub/templates?type=${type}`);
      if (!res.ok) throw new Error("Failed");
      const d = await res.json() as { templates: ContractorTemplate[] };
      return d.templates;
    },
  });
}

function useCloneTemplate() {
  const { getToken } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      const token = await getToken();
      const res = await authFetch(token, `${BASE_API}/api/contractor-hub/templates/${id}/clone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error("Failed to clone");
      return (await res.json()) as { template: ContractorTemplate };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contractor-templates"] }),
  });
}

function PreviewModal({ template, open, onClose }: { template: ContractorTemplate | null; open: boolean; onClose: () => void }) {
  if (!template) return null;
  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0">
        <DialogHeader className="p-6 pb-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <Badge variant="outline" className="text-xs">{STYLE_LABELS[template.styleLevel]}</Badge>
            <Badge variant="outline" className="text-xs capitalize">{template.templateType}</Badge>
            {template.isPlatformDefault && (
              <Badge variant="outline" className="text-xs text-muted-foreground gap-1"><Lock className="w-3 h-3" /> Platform default</Badge>
            )}
          </div>
          <DialogTitle>{template.name}</DialogTitle>
          {template.description && <DialogDescription>{template.description}</DialogDescription>}
        </DialogHeader>
        <ScrollArea className="flex-1 px-6 pb-6">
          <div className="space-y-4 pt-4">
            {template.defaultLineItems && template.defaultLineItems.length > 0 && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Default Line Items</div>
                <div className="border rounded-lg overflow-hidden text-sm">
                  <table className="w-full">
                    <thead className="bg-muted/40"><tr>
                      <th className="text-left px-3 py-2 font-medium">Description</th>
                      <th className="text-right px-3 py-2 font-medium w-16">Qty</th>
                      <th className="text-left px-3 py-2 font-medium w-20">Unit</th>
                    </tr></thead>
                    <tbody>
                      {template.defaultLineItems.map((item, i) => (
                        <tr key={i} className="border-t">
                          <td className="px-3 py-2 text-muted-foreground">{item.description}</td>
                          <td className="px-3 py-2 text-right">{item.quantity}</td>
                          <td className="px-3 py-2 text-muted-foreground">{item.unit}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {template.templateType === "proposal" && template.defaultScope && (
              <><Separator />
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Scope of Work</div>
                <pre className="text-sm whitespace-pre-wrap font-sans text-muted-foreground leading-relaxed">{template.defaultScope}</pre>
              </div></>
            )}
            {template.defaultTerms && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Terms</div>
                <pre className="text-sm whitespace-pre-wrap font-sans text-muted-foreground leading-relaxed">{template.defaultTerms}</pre>
              </div>
            )}
            {template.defaultPaymentTerms && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Payment Terms</div>
                <pre className="text-sm whitespace-pre-wrap font-sans text-muted-foreground leading-relaxed">{template.defaultPaymentTerms}</pre>
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function TemplateCard({ template, onPreview, onClone, canManage, cloning }: {
  template: ContractorTemplate; onPreview: () => void; onClone: () => void; canManage: boolean; cloning: boolean;
}) {
  return (
    <Card className="flex flex-col hover:shadow-md transition-shadow">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <Badge variant="outline" className="text-xs">{STYLE_LABELS[template.styleLevel]}</Badge>
          {template.brandingEnabled && (
            <Badge variant="outline" className="text-xs gap-1 text-primary"><Sparkles className="w-3 h-3" /> Branded</Badge>
          )}
          {template.isPlatformDefault && (
            <Badge variant="outline" className="text-xs text-muted-foreground gap-1"><Lock className="w-3 h-3" /> Platform</Badge>
          )}
        </div>
        <CardTitle className="text-base">{template.name}</CardTitle>
        {template.description && <CardDescription className="text-sm">{template.description}</CardDescription>}
      </CardHeader>
      <CardContent className="pt-0 mt-auto space-y-2">
        {template.workType && <div className="text-xs text-muted-foreground">{template.workType}</div>}
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="flex-1 gap-1" onClick={onPreview}>
            <Eye className="w-3.5 h-3.5" /> Preview
          </Button>
          {canManage && (
            <Button size="sm" variant="secondary" className="flex-1 gap-1" onClick={onClone} disabled={cloning}>
              <Copy className="w-3.5 h-3.5" /> {cloning ? "Cloning…" : "Clone"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function TemplateGrid({ type, user }: { type: "proposal" | "invoice"; user: UserProfile }) {
  const { data: templates, isLoading } = useTemplates(type);
  const cloneMutation = useCloneTemplate();
  const { toast } = useToast();
  const [preview, setPreview] = useState<ContractorTemplate | null>(null);
  const [cloningId, setCloningId] = useState<number | null>(null);
  const canManage = user.role === "admin" || user.role === "supervisor";

  async function handleClone(t: ContractorTemplate) {
    setCloningId(t.id);
    try {
      await cloneMutation.mutateAsync({ id: t.id, name: `${t.name} (Copy)` });
      toast({ title: "Cloned", description: `"${t.name} (Copy)" added to your templates.` });
    } catch {
      toast({ title: "Clone failed", variant: "destructive" });
    } finally {
      setCloningId(null);
    }
  }

  if (isLoading) {
    return <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {[1,2,3,4].map(i => <div key={i} className="h-48 bg-muted/40 rounded-xl animate-pulse" />)}
    </div>;
  }

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {(templates ?? []).map(t => (
          <TemplateCard
            key={t.id} template={t}
            onPreview={() => setPreview(t)}
            onClone={() => handleClone(t)}
            canManage={canManage} cloning={cloningId === t.id}
          />
        ))}
      </div>
      <PreviewModal template={preview} open={!!preview} onClose={() => setPreview(null)} />
    </>
  );
}

function TemplatesTab({ user }: { user: UserProfile }) {
  const [templateType, setTemplateType] = useState<"proposal" | "invoice">("proposal");
  return (
    <div className="space-y-6">
      {/* Style guide strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {STYLE_ORDER.map((level) => {
          const icons = {
            minimal: <Layers className="w-4 h-4 text-muted-foreground" />,
            standard: <FileText className="w-4 h-4 text-blue-500" />,
            detailed: <FilePlus className="w-4 h-4 text-violet-500" />,
            branded: <Sparkles className="w-4 h-4 text-primary" />,
          };
          return (
            <div key={level} className="flex items-start gap-2.5 p-3 rounded-lg border bg-card">
              <div className="mt-0.5 shrink-0">{icons[level]}</div>
              <div>
                <div className="text-sm font-semibold">{STYLE_LABELS[level]}</div>
                <div className="text-xs text-muted-foreground">{STYLE_DESCS[level]}</div>
              </div>
            </div>
          );
        })}
      </div>

      <Tabs value={templateType} onValueChange={v => setTemplateType(v as typeof templateType)}>
        <TabsList>
          <TabsTrigger value="proposal" className="gap-1.5"><FileText className="w-4 h-4" />Proposals</TabsTrigger>
          <TabsTrigger value="invoice" className="gap-1.5"><ReceiptText className="w-4 h-4" />Invoices</TabsTrigger>
        </TabsList>
      </Tabs>

      <TemplateGrid type={templateType} user={user} />
    </div>
  );
}

// ─── Main Hub Page ────────────────────────────────────────────────────────────
type HubTab = "proposals" | "invoices" | "templates";

export default function ContractorHub({ user }: { user: UserProfile }) {
  const [tab, setTab] = useState<HubTab>("proposals");

  const tabIcons: Record<HubTab, React.ReactNode> = {
    proposals: <FileText className="w-4 h-4" />,
    invoices: <ReceiptText className="w-4 h-4" />,
    templates: <LayoutTemplate className="w-4 h-4" />,
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <FileText className="w-5 h-5 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Contractor Hub</h1>
        </div>
        <p className="text-muted-foreground text-sm">
          Manage proposals and invoices, and browse reusable templates for any job.
        </p>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={v => setTab(v as HubTab)}>
        <TabsList>
          {(["proposals", "invoices", "templates"] as HubTab[]).map(t => (
            <TabsTrigger key={t} value={t} className="gap-1.5 capitalize">
              {tabIcons[t]} {t}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Tab content */}
      {tab === "proposals" && <ProposalsTab user={user} />}
      {tab === "invoices" && <InvoicesTab user={user} />}
      {tab === "templates" && <TemplatesTab user={user} />}
    </div>
  );
}
