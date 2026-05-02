import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Eye, Sparkles, Lock, LayoutTemplate, ChevronRight } from "lucide-react";

const BASE_API = import.meta.env.BASE_URL.replace(/\/$/, "");

export type LineItem = {
  description: string;
  quantity: number;
  unit: string;
  rate: number;
  amount: number;
};

export type ContractorTemplate = {
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

const STYLE_LABELS: Record<ContractorTemplate["styleLevel"], string> = {
  minimal: "Minimal",
  standard: "Standard",
  detailed: "Detailed",
  branded: "Branded",
};

const STYLE_COLORS: Record<ContractorTemplate["styleLevel"], string> = {
  minimal: "text-muted-foreground",
  standard: "text-blue-600",
  detailed: "text-violet-600",
  branded: "text-primary",
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

function TemplatePreview({ template, onClose, onApply }: {
  template: ContractorTemplate;
  onClose: () => void;
  onApply: (t: ContractorTemplate) => void;
}) {
  const isProposal = template.templateType === "proposal";
  return (
    <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0">
      <DialogHeader className="p-6 pb-3">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <Badge variant="outline" className={`text-xs ${STYLE_COLORS[template.styleLevel]}`}>
            {STYLE_LABELS[template.styleLevel]}
          </Badge>
          {template.brandingEnabled && (
            <Badge variant="outline" className="text-xs text-primary gap-1">
              <Sparkles className="w-3 h-3" /> Branded
            </Badge>
          )}
          {template.isPlatformDefault && (
            <Badge variant="outline" className="text-xs text-muted-foreground gap-1">
              <Lock className="w-3 h-3" /> Platform default
            </Badge>
          )}
        </div>
        <DialogTitle>{template.name}</DialogTitle>
        {template.description && (
          <p className="text-sm text-muted-foreground mt-1">{template.description}</p>
        )}
      </DialogHeader>
      <ScrollArea className="flex-1 px-6">
        <div className="space-y-4 pb-6">
          {(template.workType || template.pricingStructure) && (
            <div className="flex gap-6 text-sm">
              {template.workType && (
                <div><span className="font-medium">Work type: </span><span className="text-muted-foreground">{template.workType}</span></div>
              )}
              {template.pricingStructure && (
                <div><span className="font-medium">Pricing: </span><span className="text-muted-foreground">{template.pricingStructure}</span></div>
              )}
            </div>
          )}
          {template.defaultLineItems && template.defaultLineItems.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Default Line Items</div>
              <div className="border rounded-lg overflow-hidden text-sm">
                <table className="w-full">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Description</th>
                      <th className="text-right px-3 py-2 font-medium w-16">Qty</th>
                      <th className="text-left px-3 py-2 font-medium w-20">Unit</th>
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
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Terms &amp; Conditions</div>
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
      <div className="flex items-center gap-2 justify-end px-6 pb-6 pt-3 border-t">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={() => { onApply(template); onClose(); }} className="gap-1.5">
          Apply Template <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </DialogContent>
  );
}

export function TemplatePicker({
  type,
  appliedName,
  onApply,
}: {
  type: "proposal" | "invoice";
  appliedName?: string | null;
  onApply: (template: ContractorTemplate) => void;
}) {
  const { data: templates, isLoading } = useTemplates(type);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ContractorTemplate | null>(null);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setOpen(true)}
        disabled={isLoading}
      >
        <LayoutTemplate className="w-4 h-4" />
        {appliedName ? `Template: ${appliedName}` : "Apply Template"}
      </Button>

      {/* Template list dialog */}
      <Dialog open={open && !preview} onOpenChange={(v) => !v && setOpen(false)}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0">
          <DialogHeader className="p-6 pb-3">
            <DialogTitle>Choose a {type === "proposal" ? "Proposal" : "Invoice"} Template</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Select a template to prefill scope, terms, pricing, and line items. You can edit everything after.
            </p>
          </DialogHeader>
          <ScrollArea className="flex-1 px-6 pb-6">
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className="h-20 bg-muted/40 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                {(templates ?? []).map(t => (
                  <div
                    key={t.id}
                    className="flex items-center gap-3 p-3 border rounded-lg hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-0.5">
                        <span className={`text-xs font-semibold ${STYLE_COLORS[t.styleLevel]}`}>
                          {STYLE_LABELS[t.styleLevel]}
                        </span>
                        {t.isPlatformDefault && (
                          <span className="text-xs text-muted-foreground">· Platform default</span>
                        )}
                        {t.brandingEnabled && (
                          <Badge variant="outline" className="text-xs gap-1 text-primary h-4 px-1">
                            <Sparkles className="w-2.5 h-2.5" /> Branded
                          </Badge>
                        )}
                      </div>
                      <div className="font-medium text-sm">{t.name}</div>
                      {t.description && (
                        <div className="text-xs text-muted-foreground truncate">{t.description}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="gap-1 h-7 px-2"
                        onClick={() => setPreview(t)}
                      >
                        <Eye className="w-3.5 h-3.5" />
                        Preview
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 px-3"
                        onClick={() => { onApply(t); setOpen(false); }}
                      >
                        Apply
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Preview dialog */}
      <Dialog open={!!preview} onOpenChange={(v) => !v && setPreview(null)}>
        {preview && (
          <TemplatePreview
            template={preview}
            onClose={() => setPreview(null)}
            onApply={(t) => { onApply(t); setOpen(false); }}
          />
        )}
      </Dialog>
    </>
  );
}
