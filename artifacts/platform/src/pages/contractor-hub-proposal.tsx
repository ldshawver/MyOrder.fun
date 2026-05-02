import { useState, useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import type { UserProfile } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { TemplatePicker } from "@/components/contractor-hub-template-picker";
import type { ContractorTemplate, LineItem } from "@/components/contractor-hub-template-picker";
import { ArrowLeft, Plus, Trash2, Save, FileText } from "lucide-react";

const BASE_API = import.meta.env.BASE_URL.replace(/\/$/, "");

type ProposalStatus = "draft" | "sent" | "accepted" | "rejected" | "expired";

interface ProposalForm {
  title: string;
  status: ProposalStatus;
  clientName: string;
  clientEmail: string;
  clientCompany: string;
  validUntil: string;
  workType: string;
  pricingStructure: string;
  scope: string;
  terms: string;
  paymentTerms: string;
  notes: string;
  lineItems: LineItem[];
  templateId: number | null;
}

const EMPTY_FORM: ProposalForm = {
  title: "",
  status: "draft",
  clientName: "",
  clientEmail: "",
  clientCompany: "",
  validUntil: "",
  workType: "",
  pricingStructure: "",
  scope: "",
  terms: "",
  paymentTerms: "",
  notes: "",
  lineItems: [],
  templateId: null,
};

const STATUS_LABELS: Record<ProposalStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  rejected: "Rejected",
  expired: "Expired",
};

const STATUS_COLORS: Record<ProposalStatus, string> = {
  draft: "secondary",
  sent: "default",
  accepted: "default",
  rejected: "destructive",
  expired: "outline",
};

function calcTotal(items: LineItem[]): number {
  return items.reduce((acc, li) => acc + li.quantity * li.rate, 0);
}

function LineItemsEditor({
  items,
  onChange,
}: {
  items: LineItem[];
  onChange: (items: LineItem[]) => void;
}) {
  function update(index: number, field: keyof LineItem, value: string | number) {
    const next = items.map((li, i) => {
      if (i !== index) return li;
      const updated = { ...li, [field]: value };
      updated.amount = updated.quantity * updated.rate;
      return updated;
    });
    onChange(next);
  }

  function addRow() {
    onChange([...items, { description: "", quantity: 1, unit: "item", rate: 0, amount: 0 }]);
  }

  function removeRow(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-2">
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Description</th>
              <th className="text-right px-3 py-2 font-medium w-20">Qty</th>
              <th className="text-left px-3 py-2 font-medium w-24">Unit</th>
              <th className="text-right px-3 py-2 font-medium w-28">Rate ($)</th>
              <th className="text-right px-3 py-2 font-medium w-28">Amount</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground text-xs">
                  No line items yet. Click "Add Row" to start.
                </td>
              </tr>
            ) : (
              items.map((li, i) => (
                <tr key={i} className="border-t">
                  <td className="px-2 py-1.5">
                    <Input
                      value={li.description}
                      onChange={e => update(i, "description", e.target.value)}
                      placeholder="Description"
                      className="h-7 text-sm border-0 bg-transparent focus-visible:ring-1 px-1"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      type="number"
                      min={0}
                      step="any"
                      value={li.quantity}
                      onChange={e => update(i, "quantity", parseFloat(e.target.value) || 0)}
                      className="h-7 text-sm text-right border-0 bg-transparent focus-visible:ring-1 px-1 w-16 ml-auto"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      value={li.unit}
                      onChange={e => update(i, "unit", e.target.value)}
                      placeholder="unit"
                      className="h-7 text-sm border-0 bg-transparent focus-visible:ring-1 px-1"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={li.rate}
                      onChange={e => update(i, "rate", parseFloat(e.target.value) || 0)}
                      className="h-7 text-sm text-right border-0 bg-transparent focus-visible:ring-1 px-1 ml-auto"
                    />
                  </td>
                  <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">
                    ${(li.quantity * li.rate).toFixed(2)}
                  </td>
                  <td className="px-2 py-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => removeRow(i)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addRow}
          className="gap-1.5 h-7 text-xs"
        >
          <Plus className="w-3.5 h-3.5" /> Add Row
        </Button>
        {items.length > 0 && (
          <div className="text-sm font-semibold">
            Total: ${calcTotal(items).toFixed(2)}
          </div>
        )}
      </div>
    </div>
  );
}

function useProposal(id: string | undefined) {
  const { getToken } = useAuth();
  return useQuery({
    queryKey: ["contractor-proposal", id],
    enabled: !!id && id !== "new",
    queryFn: async () => {
      const token = await getToken();
      const res = await fetch(`${BASE_API}/api/contractor-hub/proposals/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load");
      const data = await res.json() as { proposal: Record<string, unknown> };
      return data.proposal;
    },
  });
}

export default function ContractorHubProposal({ user }: { user: UserProfile }) {
  const params = useParams<{ id?: string }>();
  const proposalId = params.id && params.id !== "new" ? params.id : undefined;
  const isNew = !proposalId;
  const [, setLocation] = useLocation();
  const { getToken } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: existing, isLoading } = useProposal(proposalId);
  const [form, setForm] = useState<ProposalForm>(EMPTY_FORM);
  const [appliedTemplateName, setAppliedTemplateName] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!existing) return;
    const p = existing as Record<string, unknown>;
    setForm({
      title: (p.title as string) ?? "",
      status: (p.status as ProposalStatus) ?? "draft",
      clientName: (p.clientName as string) ?? "",
      clientEmail: (p.clientEmail as string) ?? "",
      clientCompany: (p.clientCompany as string) ?? "",
      validUntil: (p.validUntil as string) ?? "",
      workType: (p.workType as string) ?? "",
      pricingStructure: (p.pricingStructure as string) ?? "",
      scope: (p.scope as string) ?? "",
      terms: (p.terms as string) ?? "",
      paymentTerms: (p.paymentTerms as string) ?? "",
      notes: (p.notes as string) ?? "",
      lineItems: (p.lineItems as LineItem[]) ?? [],
      templateId: (p.templateId as number | null) ?? null,
    });
  }, [existing]);

  function setField<K extends keyof ProposalForm>(key: K, value: ProposalForm[K]) {
    setForm(f => ({ ...f, [key]: value }));
    setDirty(true);
  }

  function applyTemplate(t: ContractorTemplate) {
    setForm(f => ({
      ...f,
      workType: t.workType ?? f.workType,
      pricingStructure: t.pricingStructure ?? f.pricingStructure,
      scope: t.defaultScope ?? f.scope,
      terms: t.defaultTerms ?? f.terms,
      paymentTerms: t.defaultPaymentTerms ?? f.paymentTerms,
      notes: t.defaultNotes ?? f.notes,
      lineItems: t.defaultLineItems ?? f.lineItems,
      templateId: t.id,
    }));
    setAppliedTemplateName(t.name);
    setDirty(true);
    toast({ title: `Template applied`, description: `"${t.name}" prefilled your proposal.` });
  }

  const saveMutation = useMutation({
    mutationFn: async (data: ProposalForm) => {
      const token = await getToken();
      const total = calcTotal(data.lineItems).toFixed(2);
      const body = {
        ...data,
        subtotal: total,
        total,
        lineItems: data.lineItems.map(li => ({ ...li, amount: li.quantity * li.rate })),
      };
      const url = isNew
        ? `${BASE_API}/api/contractor-hub/proposals`
        : `${BASE_API}/api/contractor-hub/proposals/${proposalId}`;
      const res = await fetch(url, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to save");
      const json = await res.json() as { proposal: { id: number } };
      return json.proposal;
    },
    onSuccess: (proposal) => {
      qc.invalidateQueries({ queryKey: ["contractor-proposals"] });
      qc.invalidateQueries({ queryKey: ["contractor-proposal", proposalId] });
      setDirty(false);
      toast({ title: isNew ? "Proposal created" : "Proposal saved" });
      if (isNew) setLocation(`/contractor-hub/proposals/${proposal.id}`);
    },
    onError: () => {
      toast({ title: "Save failed", description: "Could not save proposal.", variant: "destructive" });
    },
  });

  if (!isNew && isLoading) {
    return (
      <div className="p-6 max-w-4xl mx-auto space-y-4">
        <div className="h-8 w-48 bg-muted/40 rounded animate-pulse" />
        <div className="h-64 bg-muted/40 rounded animate-pulse" />
      </div>
    );
  }

  const canEdit = user.role === "admin" || user.role === "supervisor" || user.role === "business_sitter";

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 -ml-2"
          onClick={() => setLocation("/contractor-hub")}
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </Button>
        <Separator orientation="vertical" className="h-4" />
        <FileText className="w-4 h-4 text-muted-foreground" />
        <h1 className="font-semibold text-base">
          {isNew ? "New Proposal" : (form.title || "Proposal")}
        </h1>
        {!isNew && (
          <Badge variant={STATUS_COLORS[form.status] as "default" | "secondary" | "destructive" | "outline"}>
            {STATUS_LABELS[form.status]}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <TemplatePicker
            type="proposal"
            appliedName={appliedTemplateName}
            onApply={applyTemplate}
          />
          {canEdit && (
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => saveMutation.mutate(form)}
              disabled={saveMutation.isPending || (!dirty && !isNew)}
            >
              <Save className="w-4 h-4" />
              {saveMutation.isPending ? "Saving…" : "Save"}
            </Button>
          )}
        </div>
      </div>

      {/* Title + Status */}
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="title">Proposal Title</Label>
          <Input
            id="title"
            value={form.title}
            onChange={e => setField("title", e.target.value)}
            placeholder="e.g. Kitchen Renovation Proposal"
            disabled={!canEdit}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Status</Label>
          <Select
            value={form.status}
            onValueChange={v => setField("status", v as ProposalStatus)}
            disabled={!canEdit}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(STATUS_LABELS) as ProposalStatus[]).map(s => (
                <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Client Info */}
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Client Information</div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="clientName">Client Name</Label>
            <Input id="clientName" value={form.clientName} onChange={e => setField("clientName", e.target.value)} disabled={!canEdit} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="clientCompany">Company</Label>
            <Input id="clientCompany" value={form.clientCompany} onChange={e => setField("clientCompany", e.target.value)} disabled={!canEdit} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="clientEmail">Client Email</Label>
            <Input id="clientEmail" type="email" value={form.clientEmail} onChange={e => setField("clientEmail", e.target.value)} disabled={!canEdit} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="validUntil">Valid Until</Label>
            <Input id="validUntil" type="date" value={form.validUntil} onChange={e => setField("validUntil", e.target.value)} disabled={!canEdit} />
          </div>
        </div>
      </div>

      {/* Work Details */}
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Work Details</div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="workType">Work Type</Label>
            <Input id="workType" value={form.workType} onChange={e => setField("workType", e.target.value)} placeholder="e.g. Residential remodeling" disabled={!canEdit} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pricingStructure">Pricing Structure</Label>
            <Input id="pricingStructure" value={form.pricingStructure} onChange={e => setField("pricingStructure", e.target.value)} placeholder="e.g. Fixed price" disabled={!canEdit} />
          </div>
        </div>
      </div>

      {/* Line Items */}
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Line Items</div>
        <LineItemsEditor items={form.lineItems} onChange={items => setField("lineItems", items)} />
      </div>

      {/* Scope */}
      <div className="space-y-1.5">
        <Label htmlFor="scope">Scope of Work</Label>
        <Textarea
          id="scope"
          value={form.scope}
          onChange={e => setField("scope", e.target.value)}
          placeholder="Describe the work to be performed…"
          rows={6}
          className="resize-y font-mono text-sm"
          disabled={!canEdit}
        />
      </div>

      {/* Terms */}
      <div className="space-y-1.5">
        <Label htmlFor="terms">Terms &amp; Conditions</Label>
        <Textarea
          id="terms"
          value={form.terms}
          onChange={e => setField("terms", e.target.value)}
          placeholder="Proposal validity, change orders, delays…"
          rows={4}
          className="resize-y font-mono text-sm"
          disabled={!canEdit}
        />
      </div>

      {/* Payment Terms */}
      <div className="space-y-1.5">
        <Label htmlFor="paymentTerms">Payment Terms</Label>
        <Textarea
          id="paymentTerms"
          value={form.paymentTerms}
          onChange={e => setField("paymentTerms", e.target.value)}
          placeholder="Deposit, milestone payments, due dates…"
          rows={3}
          className="resize-y font-mono text-sm"
          disabled={!canEdit}
        />
      </div>

      {/* Notes */}
      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes</Label>
        <Textarea
          id="notes"
          value={form.notes}
          onChange={e => setField("notes", e.target.value)}
          placeholder="Additional notes for the client…"
          rows={2}
          className="resize-y text-sm"
          disabled={!canEdit}
        />
      </div>

      {/* Save footer */}
      {canEdit && (
        <div className="flex justify-end pt-2">
          <Button
            className="gap-1.5"
            onClick={() => saveMutation.mutate(form)}
            disabled={saveMutation.isPending || (!dirty && !isNew)}
          >
            <Save className="w-4 h-4" />
            {saveMutation.isPending ? "Saving…" : isNew ? "Create Proposal" : "Save Changes"}
          </Button>
        </div>
      )}
    </div>
  );
}
