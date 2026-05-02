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
import { ArrowLeft, Plus, Trash2, Save, ReceiptText } from "lucide-react";

const BASE_API = import.meta.env.BASE_URL.replace(/\/$/, "");

type InvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "voided";

interface InvoiceForm {
  title: string;
  status: InvoiceStatus;
  invoiceNumber: string;
  clientName: string;
  clientEmail: string;
  clientCompany: string;
  issueDate: string;
  dueDate: string;
  pricingStructure: string;
  paymentTerms: string;
  notes: string;
  lineItems: LineItem[];
  taxAmount: string;
  discountAmount: string;
  amountPaid: string;
  templateId: number | null;
}

const EMPTY_FORM: InvoiceForm = {
  title: "",
  status: "draft",
  invoiceNumber: "",
  clientName: "",
  clientEmail: "",
  clientCompany: "",
  issueDate: "",
  dueDate: "",
  pricingStructure: "",
  paymentTerms: "",
  notes: "",
  lineItems: [],
  taxAmount: "0",
  discountAmount: "0",
  amountPaid: "0",
  templateId: null,
};

const STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  paid: "Paid",
  overdue: "Overdue",
  voided: "Voided",
};

const STATUS_COLORS: Record<InvoiceStatus, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "secondary",
  sent: "default",
  paid: "default",
  overdue: "destructive",
  voided: "outline",
};

function calcTotals(form: InvoiceForm) {
  const subtotal = form.lineItems.reduce((acc, li) => acc + li.quantity * li.rate, 0);
  const tax = parseFloat(form.taxAmount) || 0;
  const discount = parseFloat(form.discountAmount) || 0;
  const paid = parseFloat(form.amountPaid) || 0;
  const total = Math.max(0, subtotal + tax - discount);
  const balance = Math.max(0, total - paid);
  return { subtotal, total, balance };
}

function LineItemsEditor({ items, onChange }: { items: LineItem[]; onChange: (items: LineItem[]) => void }) {
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
    onChange([...items, { description: "", quantity: 1, unit: "hour", rate: 0, amount: 0 }]);
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
                    <Input value={li.description} onChange={e => update(i, "description", e.target.value)} placeholder="Description" className="h-7 text-sm border-0 bg-transparent focus-visible:ring-1 px-1" />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input type="number" min={0} step="any" value={li.quantity} onChange={e => update(i, "quantity", parseFloat(e.target.value) || 0)} className="h-7 text-sm text-right border-0 bg-transparent focus-visible:ring-1 px-1 w-16 ml-auto" />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input value={li.unit} onChange={e => update(i, "unit", e.target.value)} placeholder="unit" className="h-7 text-sm border-0 bg-transparent focus-visible:ring-1 px-1" />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input type="number" min={0} step="0.01" value={li.rate} onChange={e => update(i, "rate", parseFloat(e.target.value) || 0)} className="h-7 text-sm text-right border-0 bg-transparent focus-visible:ring-1 px-1 ml-auto" />
                  </td>
                  <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">
                    ${(li.quantity * li.rate).toFixed(2)}
                  </td>
                  <td className="px-2 py-1.5">
                    <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => removeRow(i)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={addRow} className="gap-1.5 h-7 text-xs">
          <Plus className="w-3.5 h-3.5" /> Add Row
        </Button>
      </div>
    </div>
  );
}

function useInvoice(id: string | undefined) {
  const { getToken } = useAuth();
  return useQuery({
    queryKey: ["contractor-invoice", id],
    enabled: !!id && id !== "new",
    queryFn: async () => {
      const token = await getToken();
      const res = await fetch(`${BASE_API}/api/contractor-hub/invoices/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load");
      const data = await res.json() as { invoice: Record<string, unknown> };
      return data.invoice;
    },
  });
}

export default function ContractorHubInvoice({ user }: { user: UserProfile }) {
  const params = useParams<{ id?: string }>();
  const invoiceId = params.id && params.id !== "new" ? params.id : undefined;
  const isNew = !invoiceId;
  const [, setLocation] = useLocation();
  const { getToken } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: existing, isLoading } = useInvoice(invoiceId);
  const [form, setForm] = useState<InvoiceForm>(EMPTY_FORM);
  const [appliedTemplateName, setAppliedTemplateName] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!existing) return;
    const inv = existing as Record<string, unknown>;
    setForm({
      title: (inv.title as string) ?? "",
      status: (inv.status as InvoiceStatus) ?? "draft",
      invoiceNumber: (inv.invoiceNumber as string) ?? "",
      clientName: (inv.clientName as string) ?? "",
      clientEmail: (inv.clientEmail as string) ?? "",
      clientCompany: (inv.clientCompany as string) ?? "",
      issueDate: (inv.issueDate as string) ?? "",
      dueDate: (inv.dueDate as string) ?? "",
      pricingStructure: (inv.pricingStructure as string) ?? "",
      paymentTerms: (inv.paymentTerms as string) ?? "",
      notes: (inv.notes as string) ?? "",
      lineItems: (inv.lineItems as LineItem[]) ?? [],
      taxAmount: (inv.taxAmount as string) ?? "0",
      discountAmount: (inv.discountAmount as string) ?? "0",
      amountPaid: (inv.amountPaid as string) ?? "0",
      templateId: (inv.templateId as number | null) ?? null,
    });
  }, [existing]);

  function setField<K extends keyof InvoiceForm>(key: K, value: InvoiceForm[K]) {
    setForm(f => ({ ...f, [key]: value }));
    setDirty(true);
  }

  function applyTemplate(t: ContractorTemplate) {
    setForm(f => ({
      ...f,
      pricingStructure: t.pricingStructure ?? f.pricingStructure,
      paymentTerms: t.defaultPaymentTerms ?? f.paymentTerms,
      notes: t.defaultNotes ?? f.notes,
      lineItems: t.defaultLineItems ?? f.lineItems,
      templateId: t.id,
    }));
    setAppliedTemplateName(t.name);
    setDirty(true);
    toast({ title: `Template applied`, description: `"${t.name}" prefilled your invoice.` });
  }

  const saveMutation = useMutation({
    mutationFn: async (data: InvoiceForm) => {
      const token = await getToken();
      const { subtotal, total, balance } = calcTotals(data);
      const body = {
        ...data,
        subtotal: subtotal.toFixed(2),
        total: total.toFixed(2),
        balanceDue: balance.toFixed(2),
        lineItems: data.lineItems.map(li => ({ ...li, amount: li.quantity * li.rate })),
      };
      const url = isNew
        ? `${BASE_API}/api/contractor-hub/invoices`
        : `${BASE_API}/api/contractor-hub/invoices/${invoiceId}`;
      const res = await fetch(url, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to save");
      const json = await res.json() as { invoice: { id: number } };
      return json.invoice;
    },
    onSuccess: (invoice) => {
      qc.invalidateQueries({ queryKey: ["contractor-invoices"] });
      qc.invalidateQueries({ queryKey: ["contractor-invoice", invoiceId] });
      setDirty(false);
      toast({ title: isNew ? "Invoice created" : "Invoice saved" });
      if (isNew) setLocation(`/contractor-hub/invoices/${invoice.id}`);
    },
    onError: () => {
      toast({ title: "Save failed", description: "Could not save invoice.", variant: "destructive" });
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
  const { subtotal, total, balance } = calcTotals(form);

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" className="gap-1.5 -ml-2" onClick={() => setLocation("/contractor-hub")}>
          <ArrowLeft className="w-4 h-4" /> Back
        </Button>
        <Separator orientation="vertical" className="h-4" />
        <ReceiptText className="w-4 h-4 text-muted-foreground" />
        <h1 className="font-semibold text-base">{isNew ? "New Invoice" : (form.title || "Invoice")}</h1>
        {!isNew && (
          <Badge variant={STATUS_COLORS[form.status]}>{STATUS_LABELS[form.status]}</Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <TemplatePicker type="invoice" appliedName={appliedTemplateName} onApply={applyTemplate} />
          {canEdit && (
            <Button size="sm" className="gap-1.5" onClick={() => saveMutation.mutate(form)} disabled={saveMutation.isPending || (!dirty && !isNew)}>
              <Save className="w-4 h-4" />
              {saveMutation.isPending ? "Saving…" : "Save"}
            </Button>
          )}
        </div>
      </div>

      {/* Title + Status */}
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="title">Invoice Title</Label>
          <Input id="title" value={form.title} onChange={e => setField("title", e.target.value)} placeholder="e.g. Kitchen Renovation — Final Invoice" disabled={!canEdit} />
        </div>
        <div className="space-y-1.5">
          <Label>Status</Label>
          <Select value={form.status} onValueChange={v => setField("status", v as InvoiceStatus)} disabled={!canEdit}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(STATUS_LABELS) as InvoiceStatus[]).map(s => (
                <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Invoice details */}
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Invoice Details</div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="invoiceNumber">Invoice Number</Label>
            <Input id="invoiceNumber" value={form.invoiceNumber} onChange={e => setField("invoiceNumber", e.target.value)} placeholder="INV-001" disabled={!canEdit} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pricingStructure">Pricing Structure</Label>
            <Input id="pricingStructure" value={form.pricingStructure} onChange={e => setField("pricingStructure", e.target.value)} placeholder="e.g. Itemized labor and materials" disabled={!canEdit} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="issueDate">Issue Date</Label>
            <Input id="issueDate" type="date" value={form.issueDate} onChange={e => setField("issueDate", e.target.value)} disabled={!canEdit} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dueDate">Due Date</Label>
            <Input id="dueDate" type="date" value={form.dueDate} onChange={e => setField("dueDate", e.target.value)} disabled={!canEdit} />
          </div>
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
        </div>
      </div>

      {/* Line Items */}
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Line Items</div>
        <LineItemsEditor items={form.lineItems} onChange={items => setField("lineItems", items)} />
      </div>

      {/* Totals */}
      <div className="border rounded-lg p-4 bg-muted/20 space-y-2 ml-auto max-w-xs">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Subtotal</span>
          <span className="tabular-nums">${subtotal.toFixed(2)}</span>
        </div>
        <div className="flex justify-between text-sm items-center gap-2">
          <span className="text-muted-foreground">Tax</span>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={form.taxAmount}
            onChange={e => setField("taxAmount", e.target.value)}
            className="h-6 text-sm text-right w-24 px-2"
            disabled={!canEdit}
          />
        </div>
        <div className="flex justify-between text-sm items-center gap-2">
          <span className="text-muted-foreground">Discount</span>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={form.discountAmount}
            onChange={e => setField("discountAmount", e.target.value)}
            className="h-6 text-sm text-right w-24 px-2"
            disabled={!canEdit}
          />
        </div>
        <Separator />
        <div className="flex justify-between text-sm font-semibold">
          <span>Total</span>
          <span className="tabular-nums">${total.toFixed(2)}</span>
        </div>
        <div className="flex justify-between text-sm items-center gap-2">
          <span className="text-muted-foreground">Amount Paid</span>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={form.amountPaid}
            onChange={e => setField("amountPaid", e.target.value)}
            className="h-6 text-sm text-right w-24 px-2"
            disabled={!canEdit}
          />
        </div>
        <Separator />
        <div className="flex justify-between text-base font-bold">
          <span>Balance Due</span>
          <span className="tabular-nums">${balance.toFixed(2)}</span>
        </div>
      </div>

      {/* Payment Terms */}
      <div className="space-y-1.5">
        <Label htmlFor="paymentTerms">Payment Terms</Label>
        <Textarea id="paymentTerms" value={form.paymentTerms} onChange={e => setField("paymentTerms", e.target.value)} placeholder="Net 30, accepted payment methods…" rows={3} className="resize-y font-mono text-sm" disabled={!canEdit} />
      </div>

      {/* Notes */}
      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" value={form.notes} onChange={e => setField("notes", e.target.value)} placeholder="Additional notes or remittance instructions…" rows={2} className="resize-y text-sm" disabled={!canEdit} />
      </div>

      {canEdit && (
        <div className="flex justify-end pt-2">
          <Button className="gap-1.5" onClick={() => saveMutation.mutate(form)} disabled={saveMutation.isPending || (!dirty && !isNew)}>
            <Save className="w-4 h-4" />
            {saveMutation.isPending ? "Saving…" : isNew ? "Create Invoice" : "Save Changes"}
          </Button>
        </div>
      )}
    </div>
  );
}
