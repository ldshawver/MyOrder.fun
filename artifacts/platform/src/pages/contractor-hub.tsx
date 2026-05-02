import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { UserProfile } from "@workspace/api-client-react";
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
import { Copy, Eye, FileText, FilePlus, Layers, ReceiptText, Sparkles, Lock } from "lucide-react";

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
  createdAt: string;
  updatedAt: string;
};

const STYLE_ORDER: ContractorTemplate["styleLevel"][] = ["minimal", "standard", "detailed", "branded"];

const STYLE_LABELS: Record<ContractorTemplate["styleLevel"], string> = {
  minimal: "Minimal",
  standard: "Standard",
  detailed: "Detailed",
  branded: "Branded",
};

const STYLE_DESCRIPTIONS: Record<ContractorTemplate["styleLevel"], string> = {
  minimal: "Clean and simple — get to the point fast",
  standard: "Professional and complete — covers all the bases",
  detailed: "Comprehensive — ideal for complex or high-value jobs",
  branded: "Polished with your logo and brand colors",
};

function useTemplates(type: "proposal" | "invoice") {
  const { getToken } = useAuth();
  return useQuery({
    queryKey: ["contractor-templates", type],
    queryFn: async () => {
      const token = await getToken();
      const res = await fetch(`${BASE_API}/api/contractor-hub/templates?type=${type}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load templates");
      const data = await res.json() as { templates: ContractorTemplate[] };
      return data.templates;
    },
  });
}

function useCloneTemplate() {
  const { getToken } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      const token = await getToken();
      const res = await fetch(`${BASE_API}/api/contractor-hub/templates/${id}/clone`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error("Failed to clone template");
      return (await res.json()) as { template: ContractorTemplate };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contractor-templates"] });
    },
  });
}

function styleBadgeVariant(level: ContractorTemplate["styleLevel"]) {
  const map: Record<typeof level, "secondary" | "default" | "outline" | "destructive"> = {
    minimal: "outline",
    standard: "secondary",
    detailed: "default",
    branded: "default",
  };
  return map[level];
}

function PreviewModal({
  template,
  open,
  onClose,
}: {
  template: ContractorTemplate | null;
  open: boolean;
  onClose: () => void;
}) {
  if (!template) return null;

  const isProposal = template.templateType === "proposal";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0">
        <DialogHeader className="p-6 pb-0">
          <div className="flex items-center gap-2 mb-1">
            <Badge variant={styleBadgeVariant(template.styleLevel)}>
              {STYLE_LABELS[template.styleLevel]}
            </Badge>
            <Badge variant="outline" className="capitalize">
              {template.templateType}
            </Badge>
            {template.isPlatformDefault && (
              <Badge variant="outline" className="text-muted-foreground gap-1">
                <Lock className="w-3 h-3" /> Platform default
              </Badge>
            )}
          </div>
          <DialogTitle>{template.name}</DialogTitle>
          {template.description && (
            <DialogDescription>{template.description}</DialogDescription>
          )}
        </DialogHeader>

        <ScrollArea className="flex-1 px-6 pb-6">
          <div className="space-y-5 pt-4">
            {template.workType && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Work Type</div>
                <div className="text-sm">{template.workType}</div>
              </div>
            )}
            {template.pricingStructure && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Pricing Structure</div>
                <div className="text-sm">{template.pricingStructure}</div>
              </div>
            )}
            {template.defaultLineItems && template.defaultLineItems.length > 0 && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Default Line Items</div>
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">Description</th>
                        <th className="text-right px-3 py-2 font-medium">Qty</th>
                        <th className="text-left px-3 py-2 font-medium">Unit</th>
                      </tr>
                    </thead>
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
            {isProposal && template.defaultScope && (
              <>
                <Separator />
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Scope of Work</div>
                  <pre className="text-sm whitespace-pre-wrap font-sans text-muted-foreground leading-relaxed">{template.defaultScope}</pre>
                </div>
              </>
            )}
            {isProposal && template.defaultTerms && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Terms & Conditions</div>
                <pre className="text-sm whitespace-pre-wrap font-sans text-muted-foreground leading-relaxed">{template.defaultTerms}</pre>
              </div>
            )}
            {template.defaultPaymentTerms && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Payment Terms</div>
                <pre className="text-sm whitespace-pre-wrap font-sans text-muted-foreground leading-relaxed">{template.defaultPaymentTerms}</pre>
              </div>
            )}
            {template.defaultNotes && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Notes</div>
                <pre className="text-sm whitespace-pre-wrap font-sans text-muted-foreground leading-relaxed">{template.defaultNotes}</pre>
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function TemplateCard({
  template,
  onPreview,
  onClone,
  canManage,
  cloning,
}: {
  template: ContractorTemplate;
  onPreview: () => void;
  onClone: () => void;
  canManage: boolean;
  cloning: boolean;
}) {
  const lineCount = template.defaultLineItems?.length ?? 0;

  return (
    <Card className="flex flex-col hover:shadow-md transition-shadow">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1.5 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={styleBadgeVariant(template.styleLevel)} className="text-xs">
                {STYLE_LABELS[template.styleLevel]}
              </Badge>
              {template.brandingEnabled && (
                <Badge variant="outline" className="text-xs gap-1 text-primary">
                  <Sparkles className="w-3 h-3" /> Branded
                </Badge>
              )}
              {template.isPlatformDefault && (
                <Badge variant="outline" className="text-xs text-muted-foreground gap-1">
                  <Lock className="w-3 h-3" /> Platform
                </Badge>
              )}
            </div>
            <CardTitle className="text-base leading-tight">{template.name}</CardTitle>
          </div>
        </div>
        {template.description && (
          <CardDescription className="text-sm">{template.description}</CardDescription>
        )}
      </CardHeader>

      <CardContent className="pt-0 mt-auto space-y-3">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {template.workType && <span>{template.workType}</span>}
          {template.workType && lineCount > 0 && <span>·</span>}
          {lineCount > 0 && (
            <span>{lineCount} line item{lineCount !== 1 ? "s" : ""}</span>
          )}
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1 gap-1.5"
            onClick={onPreview}
          >
            <Eye className="w-3.5 h-3.5" />
            Preview
          </Button>
          {canManage && (
            <Button
              size="sm"
              variant="secondary"
              className="flex-1 gap-1.5"
              onClick={onClone}
              disabled={cloning}
            >
              <Copy className="w-3.5 h-3.5" />
              {cloning ? "Cloning…" : "Clone"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function TemplateGrid({
  type,
  user,
}: {
  type: "proposal" | "invoice";
  user: UserProfile;
}) {
  const { data: templates, isLoading, isError } = useTemplates(type);
  const cloneMutation = useCloneTemplate();
  const { toast } = useToast();
  const [previewTarget, setPreviewTarget] = useState<ContractorTemplate | null>(null);
  const [cloningId, setCloningId] = useState<number | null>(null);

  const canManage = user.role === "admin" || user.role === "supervisor";

  async function handleClone(template: ContractorTemplate) {
    setCloningId(template.id);
    try {
      await cloneMutation.mutateAsync({ id: template.id, name: `${template.name} (Copy)` });
      toast({ title: "Template cloned", description: `"${template.name} (Copy)" added to your company templates.` });
    } catch {
      toast({ title: "Clone failed", description: "Could not clone template.", variant: "destructive" });
    } finally {
      setCloningId(null);
    }
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {STYLE_ORDER.map((s) => (
          <div key={s} className="h-52 rounded-xl bg-muted/40 animate-pulse" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-center py-16 text-muted-foreground text-sm">
        Failed to load templates. Please try again.
      </div>
    );
  }

  const grouped: Partial<Record<ContractorTemplate["styleLevel"], ContractorTemplate>> = {};
  for (const t of templates ?? []) {
    if (!grouped[t.styleLevel]) grouped[t.styleLevel] = t;
  }

  const rows = STYLE_ORDER.map((s) => grouped[s]).filter(Boolean) as ContractorTemplate[];
  const extras = (templates ?? []).filter(t => !STYLE_ORDER.includes(t.styleLevel) || !grouped[t.styleLevel]);
  const all = [...rows, ...extras];

  return (
    <>
      {all.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm">
          No templates available yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {all.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              onPreview={() => setPreviewTarget(t)}
              onClone={() => handleClone(t)}
              canManage={canManage}
              cloning={cloningId === t.id}
            />
          ))}
        </div>
      )}
      <PreviewModal
        template={previewTarget}
        open={previewTarget !== null}
        onClose={() => setPreviewTarget(null)}
      />
    </>
  );
}

export default function ContractorHub({ user }: { user: UserProfile }) {
  const [tab, setTab] = useState<"proposal" | "invoice">("proposal");

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <FileText className="w-5 h-5 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight">Contractor Hub</h1>
          </div>
          <p className="text-muted-foreground text-sm max-w-xl">
            Reusable proposal and invoice templates. Preview any template or clone it to customize for your company.
          </p>
        </div>
      </div>

      {/* Style guide */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {STYLE_ORDER.map((level) => {
          const icons = {
            minimal: <Layers className="w-4 h-4 text-muted-foreground" />,
            standard: <FileText className="w-4 h-4 text-blue-500" />,
            detailed: <FilePlus className="w-4 h-4 text-violet-500" />,
            branded: <Sparkles className="w-4 h-4 text-primary" />,
          };
          return (
            <div
              key={level}
              className="flex items-start gap-2.5 p-3 rounded-lg border bg-card text-card-foreground"
            >
              <div className="mt-0.5 shrink-0">{icons[level]}</div>
              <div>
                <div className="text-sm font-semibold">{STYLE_LABELS[level]}</div>
                <div className="text-xs text-muted-foreground leading-snug mt-0.5">
                  {STYLE_DESCRIPTIONS[level]}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="proposal" className="gap-1.5">
            <FileText className="w-4 h-4" />
            Proposals
          </TabsTrigger>
          <TabsTrigger value="invoice" className="gap-1.5">
            <ReceiptText className="w-4 h-4" />
            Invoices
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Grid */}
      <TemplateGrid type={tab} user={user} />
    </div>
  );
}
