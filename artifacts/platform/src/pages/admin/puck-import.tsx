import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/react";
import { Render, type Data } from "@measured/puck";
import { Eye, FileInput, RefreshCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { visualEditorConfig } from "@/visual-editor/puckConfig";
import { useToast } from "@/hooks/use-toast";

type ImportablePage = { id: number; title: string; slug: string; path: string; status: string };
type Preview = { source: { pageId: number; path: string; title: string }; sanitizedHtml: string; puckData: Data };
type CreatedPage = { id: number; title: string; slug: string; status: string };
async function readError(res: Response) { try { return ((await res.json()) as { error?: string }).error ?? `${res.status} ${res.statusText}`; } catch { return `${res.status} ${res.statusText}`; } }

export default function PuckImportPage() {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const [pages, setPages] = useState<ImportablePage[]>([]);
  const [selectedPageId, setSelectedPageId] = useState<string>("");
  const [manualPath, setManualPath] = useState("");
  const [title, setTitle] = useState("Imported page");
  const [slug, setSlug] = useState("imported-page");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const authHeaders = useCallback(async () => ({ "Content-Type": "application/json", ...((await getToken()) ? { Authorization: `Bearer ${await getToken()}` } : {}) }), [getToken]);
  const api = useCallback(async <T,>(url: string, init?: RequestInit): Promise<T> => { const res = await fetch(url, { ...init, headers: { ...(await authHeaders()), ...(init?.headers ?? {}) } }); if (!res.ok) throw new Error(await readError(res)); return await res.json() as T; }, [authHeaders]);
  const source = useMemo(() => selectedPageId ? { sourceType: "page_id", pageId: Number(selectedPageId) } : { sourceType: "internal_path", path: manualPath }, [manualPath, selectedPageId]);

  const loadImportable = useCallback(async () => { const body = await api<{ pages: ImportablePage[] }>("/api/admin/pages/importable"); setPages(body.pages); if (!selectedPageId && body.pages[0]) setSelectedPageId(String(body.pages[0].id)); }, [api, selectedPageId]);
  useEffect(() => { void loadImportable(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runPreview = async () => { setBusy(true); try { const body = await api<Preview>("/api/admin/pages/import/preview", { method: "POST", body: JSON.stringify(source) }); setPreview(body); setTitle(`Imported ${body.source.title}`); setSlug(`${body.source.path.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "page"}-imported`.toLowerCase()); toast({ title: "Preview ready", description: "Review the sanitized Puck blocks before saving." }); } catch (err) { toast({ title: "Preview failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" }); } finally { setBusy(false); } };
  const saveDraft = async () => { setBusy(true); try { const created = await api<CreatedPage>("/api/admin/pages/import", { method: "POST", body: JSON.stringify({ ...source, title, slug }) }); toast({ title: "Imported as draft", description: created.title }); window.location.href = `/admin/visual-editor/${created.id}`; } catch (err) { toast({ title: "Import failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" }); } finally { setBusy(false); } };

  return <div className="space-y-6">
    <div><h1 className="text-3xl font-bold">Import Existing Page</h1><p className="text-sm text-muted-foreground">Safely convert an internal tenant page into draft-only Puck JSON. External URLs and scripts are rejected server-side.</p></div>
    <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
      <Card><CardHeader><CardTitle>Source</CardTitle><CardDescription>Choose a known page or enter a same-origin internal path.</CardDescription></CardHeader><CardContent className="space-y-3">
        <select className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={selectedPageId} onChange={(e) => { setSelectedPageId(e.target.value); setManualPath(""); }}><option value="">Manual internal path</option>{pages.map((p) => <option key={p.id} value={p.id}>{p.title} ({p.path})</option>)}</select>
        <Input value={manualPath} onChange={(e) => { setManualPath(e.target.value); setSelectedPageId(""); }} placeholder="/about" />
        <Button className="w-full" onClick={() => void runPreview()} disabled={busy || (!selectedPageId && !manualPath)}><Eye className="mr-2 h-4 w-4" />Preview detected content</Button>
        <Button variant="outline" className="w-full" onClick={() => void loadImportable()} disabled={busy}><RefreshCw className="mr-2 h-4 w-4" />Reload page list</Button>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Draft details</CardTitle><CardDescription>The original published page is not overwritten. Publishing still requires the normal editor flow.</CardDescription></CardHeader><CardContent className="space-y-3"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Draft title" /><Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="draft-slug" /><Button onClick={() => void saveDraft()} disabled={busy || !preview}><Save className="mr-2 h-4 w-4" />Import as Draft</Button></CardContent></Card>
    </div>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><FileInput className="h-5 w-5" />Preview panel</CardTitle></CardHeader><CardContent>{preview ? <div className="space-y-4"><div className="rounded-xl border p-4"><Render config={visualEditorConfig} data={preview.puckData} /></div><details><summary className="cursor-pointer text-sm font-medium">Sanitized HTML</summary><pre className="mt-2 max-h-72 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">{preview.sanitizedHtml}</pre></details></div> : <p className="text-sm text-muted-foreground">Run preview to see the converted Puck structure.</p>}</CardContent></Card>
  </div>;
}
