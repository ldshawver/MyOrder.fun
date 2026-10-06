import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, History, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  defaultBlocks,
  fromLayout,
  makeBlock,
  moveBlock,
  textProblem,
  toLayout,
  MAX_BLOCKS,
  MAX_LABEL,
  MAX_TEXT,
  type DesignerBlock,
  type ItemOption,
} from "@/lib/receiptDesigner";
import { errorText, usePrintApi } from "./print-api";

type Template = { id: number; name: string; jobType: string; version: number; isDefault: boolean; isActive: boolean; paperWidth: string; templateJson: unknown };
type Field = { field: string; label: string };
type Version = { version: number; paperWidth: string; createdAt: string };

const ITEM_OPTIONS: Array<{ key: ItemOption; label: string; defaultOn: boolean }> = [
  { key: "showOption", label: "Option / variant", defaultOn: true },
  { key: "showSku", label: "SKU", defaultOn: false },
  { key: "showUnitPrice", label: "Unit price", defaultOn: false },
  { key: "showItemNotes", label: "Item notes", defaultOn: true },
];
const select = "h-8 rounded border bg-background px-1 text-xs";

/**
 * Receipt layout designer. Edits the tenant's receipt template as blocks;
 * the server allowlist decides which fields exist, validates every save and
 * renders the preview with the same engine used for printed receipts.
 */
export default function ReceiptDesigner() {
  const call = usePrintApi();
  const [fields, setFields] = useState<Field[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [current, setCurrent] = useState<Template | null>(null);
  const [name, setName] = useState("Customer receipt");
  const [paperWidth, setPaperWidth] = useState<"50mm" | "80mm">("80mm");
  const [blocks, setBlocks] = useState<DesignerBlock[]>(defaultBlocks);
  const [preview, setPreview] = useState("");
  const [previewNote, setPreviewNote] = useState("");
  const [versions, setVersions] = useState<Version[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const fieldLabel = useMemo(() => new Map(fields.map((field) => [field.field, field.label])), [fields]);
  const problems = useMemo(() => blocks.flatMap((block) => {
    const problem = block.kind === "text" ? textProblem(block.text, MAX_TEXT) : block.kind === "data" ? textProblem(block.label, MAX_LABEL) : null;
    return problem ? [`${block.id}: ${problem}`] : [];
  }), [blocks]);

  const load = useCallback(async () => {
    const [fieldRes, templateRes] = await Promise.all([
      call<{ fields: Field[] }>("/api/print/templates/receipt-fields"),
      call<{ templates: Template[] }>("/api/print/templates"),
    ]);
    if (fieldRes.ok) setFields(fieldRes.body.fields);
    if (templateRes.ok) {
      const receipts = (templateRes.body.templates ?? []).filter((template) => template.jobType === "receipt" && template.isActive);
      setTemplates(receipts);
      return receipts;
    }
    setMessage({ kind: "error", text: errorText(templateRes.body, "Could not load receipt templates") });
    return [];
  }, [call]);

  const open = useCallback(async (template: Template | null) => {
    setMessage(null);
    setCurrent(template);
    if (template) {
      setName(template.name);
      setPaperWidth(template.paperWidth === "50mm" || template.paperWidth === "58mm" ? "50mm" : "80mm");
      setBlocks(fromLayout(template.templateJson));
      const res = await call<{ versions: Version[] }>(`/api/print/templates/${template.id}/versions`);
      setVersions(res.ok ? res.body.versions : []);
    } else {
      setName("Customer receipt");
      setPaperWidth("80mm");
      setBlocks(defaultBlocks());
      setVersions([]);
    }
  }, [call]);

  useEffect(() => {
    void load().then((receipts) => open(receipts.find((template) => template.isDefault) ?? receipts[0] ?? null));
  }, [load, open]);

  // Live preview: the server renders the unsaved layout with sample data.
  useEffect(() => {
    if (problems.length) { setPreviewNote("Fix the highlighted text to preview"); return; }
    const timer = setTimeout(async () => {
      const res = await call<{ text?: string; error?: string }>("/api/print/preview/receipt", {
        method: "POST", body: JSON.stringify({ templateJson: toLayout(blocks), paperWidth }),
      });
      if (res.ok) { setPreview(res.body.text ?? ""); setPreviewNote(""); }
      else setPreviewNote(errorText(res.body, "Preview failed"));
    }, 350);
    return () => clearTimeout(timer);
  }, [blocks, paperWidth, problems.length, call]);

  const update = (index: number, patch: Partial<DesignerBlock>) =>
    setBlocks((all) => all.map((block, i) => (i === index ? ({ ...block, ...patch } as DesignerBlock) : block)));

  function add(kind: "data" | "text" | "separator") {
    if (blocks.length >= MAX_BLOCKS) return;
    const taken = new Set(blocks.map((block) => block.id));
    setBlocks((all) => [...all, makeBlock(kind, taken, fields[0]?.field ?? "orderNumber")]);
  }

  async function save(makeDefault: boolean) {
    setBusy(true);
    setMessage(null);
    const body = { name: name.trim() || "Customer receipt", templateJson: toLayout(blocks), paperWidth, ...(makeDefault ? { isDefault: true } : {}) };
    const res = current
      ? await call<{ template: Template }>(`/api/print/templates/${current.id}`, { method: "PATCH", body: JSON.stringify({ ...body, expectedVersion: current.version }) })
      : await call<{ template: Template }>("/api/print/templates", { method: "POST", body: JSON.stringify({ ...body, jobType: "receipt" }) });
    if (res.ok) {
      const receipts = await load();
      await open(receipts.find((template) => template.id === res.body.template.id) ?? null);
      setMessage({ kind: "success", text: `Saved version ${res.body.template.version}${makeDefault || res.body.template.isDefault ? " - used for receipts" : ""}` });
    } else {
      setMessage({ kind: "error", text: errorText(res.body, "Save failed") });
    }
    setBusy(false);
  }

  async function restore(version: number) {
    if (!current) return;
    setBusy(true);
    const res = await call<{ template: Template }>(`/api/print/templates/${current.id}/versions/${version}/restore`, { method: "POST", body: "{}" });
    if (res.ok) {
      const receipts = await load();
      await open(receipts.find((template) => template.id === current.id) ?? null);
      setMessage({ kind: "success", text: `Restored version ${version} as version ${res.body.template.version}` });
    } else setMessage({ kind: "error", text: errorText(res.body, "Restore failed") });
    setBusy(false);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]" data-testid="receipt-designer">
      <section className="space-y-3 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Receipt template" className="h-9 rounded border bg-background px-2 text-sm" value={current?.id ?? ""}
            onChange={(event) => void open(templates.find((template) => template.id === Number(event.target.value)) ?? null)}>
            <option value="">New template</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>{template.name} v{template.version}{template.isDefault ? " (in use)" : ""}</option>
            ))}
          </select>
          <Input aria-label="Template name" className="h-9 w-48" value={name} onChange={(event) => setName(event.target.value)} />
          <select aria-label="Paper width" className="h-9 rounded border bg-background px-2 text-sm" value={paperWidth} onChange={(event) => setPaperWidth(event.target.value as "50mm" | "80mm")}>
            <option value="80mm">80mm roll</option>
            <option value="50mm">50mm roll</option>
          </select>
        </div>

        <ol className="space-y-2" aria-label="Receipt blocks">
          {blocks.map((block, index) => (
            <li key={block.id} className={`rounded-lg border p-2 text-xs space-y-2 ${block.enabled ? "border-border/50" : "border-dashed border-border/40 opacity-60"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <input type="checkbox" aria-label="Show block" checked={block.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} />
                {block.kind === "data" ? (
                  <select aria-label="Field" className={select} value={block.field} onChange={(event) => update(index, { field: event.target.value })}>
                    {!fieldLabel.has(block.field) ? <option value={block.field}>{block.field}</option> : null}
                    {fields.map((field) => <option key={field.field} value={field.field}>{field.label}</option>)}
                  </select>
                ) : (
                  <span className="font-medium">{block.kind === "text" ? "Custom text" : "Separator"}</span>
                )}
                {block.kind === "separator" ? (
                  <select aria-label="Separator style" className={select} value={block.style} onChange={(event) => update(index, { style: event.target.value as typeof block.style })}>
                    <option value="solid">Solid ----</option>
                    <option value="dashed">Dashed - - -</option>
                    <option value="double">Double ====</option>
                  </select>
                ) : (
                  <>
                    <select aria-label="Alignment" className={select} value={block.align} onChange={(event) => update(index, { align: event.target.value as typeof block.align })}>
                      <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
                    </select>
                    <select aria-label="Size" className={select} value={block.size} onChange={(event) => update(index, { size: event.target.value as typeof block.size })}>
                      <option value="normal">Normal</option><option value="tall">Tall</option><option value="large">Large</option>
                    </select>
                    <label className="flex items-center gap-1"><input type="checkbox" checked={block.bold} onChange={(event) => update(index, { bold: event.target.checked })} />Bold</label>
                  </>
                )}
                <label className="flex items-center gap-1">Space
                  <select aria-label="Space before" className={select} value={block.spaceBefore} onChange={(event) => update(index, { spaceBefore: Number(event.target.value) })}>
                    {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} above</option>)}
                  </select>
                  <select aria-label="Space after" className={select} value={block.spaceAfter} onChange={(event) => update(index, { spaceAfter: Number(event.target.value) })}>
                    {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} below</option>)}
                  </select>
                </label>
                <span className="ml-auto flex gap-1">
                  <Button size="sm" variant="ghost" aria-label="Move up" disabled={index === 0} onClick={() => setBlocks((all) => moveBlock(all, index, -1))}><ArrowUp size={12} /></Button>
                  <Button size="sm" variant="ghost" aria-label="Move down" disabled={index === blocks.length - 1} onClick={() => setBlocks((all) => moveBlock(all, index, 1))}><ArrowDown size={12} /></Button>
                  <Button size="sm" variant="ghost" aria-label="Remove block" onClick={() => setBlocks((all) => all.filter((_, i) => i !== index))}><Trash2 size={12} /></Button>
                </span>
              </div>
              {block.kind === "text" ? (
                <Input aria-label="Custom text" value={block.text} maxLength={MAX_TEXT} onChange={(event) => update(index, { text: event.target.value })} placeholder="Plain text only" />
              ) : null}
              {block.kind === "data" ? (
                <Input aria-label="Label" value={block.label} maxLength={MAX_LABEL} onChange={(event) => update(index, { label: event.target.value })} placeholder="Label (optional, plain text)" />
              ) : null}
              {block.kind === "data" && block.field === "items" ? (
                <div className="flex flex-wrap gap-3">
                  {ITEM_OPTIONS.map((option) => (
                    <label key={option.key} className="flex items-center gap-1">
                      <input type="checkbox" checked={block.itemOptions[option.key] ?? option.defaultOn}
                        onChange={(event) => update(index, { itemOptions: { ...block.itemOptions, [option.key]: event.target.checked } })} />
                      {option.label}
                    </label>
                  ))}
                  <span className="text-muted-foreground">Name, quantity and line total always print.</span>
                </div>
              ) : null}
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => add("data")}><Plus size={12} className="mr-1" />Field</Button>
          <Button size="sm" variant="outline" onClick={() => add("text")}><Plus size={12} className="mr-1" />Custom text</Button>
          <Button size="sm" variant="outline" onClick={() => add("separator")}><Plus size={12} className="mr-1" />Separator</Button>
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" disabled={busy || problems.length > 0} onClick={() => void save(false)}>
              {busy ? <Loader2 size={12} className="mr-1 animate-spin" /> : <Save size={12} className="mr-1" />}Save
            </Button>
            <Button size="sm" disabled={busy || problems.length > 0} onClick={() => void save(true)}>Save and use for receipts</Button>
          </span>
        </div>
        {problems.length ? <p className="text-xs text-red-300" role="alert">{problems.join("; ")}</p> : null}
        {message ? (
          <p className={`text-xs ${message.kind === "error" ? "text-red-300" : "text-green-300"}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>
        ) : null}

        {versions.length ? (
          <details className="rounded-lg border border-border/40 p-2 text-xs">
            <summary className="cursor-pointer"><History size={12} className="inline mr-1" />Version history</summary>
            <ul className="mt-2 space-y-1">
              {versions.map((version) => (
                <li key={version.version} className="flex items-center justify-between gap-2">
                  <span>Version {version.version} · {version.paperWidth} · {new Date(version.createdAt).toLocaleString()}</span>
                  {version.version !== current?.version ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void restore(version.version)}>Restore as new version</Button>
                  ) : <span className="text-muted-foreground">current</span>}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section aria-label="Receipt preview" className="space-y-2">
        <div className="text-xs font-semibold">SAMPLE / PREVIEW</div>
        <pre
          className="rounded-md bg-white text-black shadow-inner p-3 text-[11px] leading-tight font-mono whitespace-pre overflow-x-auto"
          style={{ width: `${paperWidth === "50mm" ? 34 : 50}ch`, maxWidth: "100%" }}
          data-testid="receipt-preview"
        >
          {preview || "Loading preview…"}
        </pre>
        {previewNote ? <p className="text-xs text-amber-300" role="status">{previewNote}</p> : null}
        <p className="text-xs text-muted-foreground max-w-[50ch]">Sample data only. The printer applies bold and large text; the server renderer is authoritative.</p>
      </section>
    </div>
  );
}
