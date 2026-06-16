import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { Puck, Render, type Data } from "@measured/puck";
import "@measured/puck/puck.css";
import { Archive, Eye, History, Plus, RefreshCw, Rocket, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { defaultVisualEditorData, visualEditorConfig } from "@/visual-editor/puckConfig";

type Page = { id: number; slug: string; title: string; status: string; draftJson?: Data; publishedJson?: Data | null; updatedAt?: string; publishedAt?: string | null; archivedAt?: string | null };
type Version = { id: number; createdAt: string; title: string; slug: string };
async function readError(res: Response) { try { return ((await res.json()) as { error?: string }).error ?? `${res.status} ${res.statusText}`; } catch { return `${res.status} ${res.statusText}`; } }

export default function AdminVisualEditor() {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const [pages, setPages] = useState<Page[]>([]);
  const [page, setPage] = useState<Page | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [editorData, setEditorData] = useState<Data>(defaultVisualEditorData);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newSlug, setNewSlug] = useState("home");
  const [newTitle, setNewTitle] = useState("Home page");
  const latestDataRef = useRef<Data>(defaultVisualEditorData);
  const authHeaders = useCallback(async () => ({ "Content-Type": "application/json", ...((await getToken()) ? { Authorization: `Bearer ${await getToken()}` } : {}) }), [getToken]);
  const api = useCallback(async <T,>(url: string, init?: RequestInit): Promise<T> => { const res = await fetch(url, { ...init, headers: { ...(await authHeaders()), ...(init?.headers ?? {}) } }); if (!res.ok) throw new Error(await readError(res)); return await res.json() as T; }, [authHeaders]);

  const loadPages = useCallback(async () => { setLoading(true); setError(null); try { const body = await api<{ pages: Page[] }>("/api/admin/visual-editor/pages"); setPages(body.pages); if (!page && body.pages[0]) await loadPage(body.pages[0].id); } catch (err) { setError(err instanceof Error ? err.message : "Could not load pages"); } finally { setLoading(false); } }, [api, page]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadPage = useCallback(async (id: number) => { const body = await api<Page>(`/api/admin/visual-editor/pages/${id}`); setPage(body); const data = body.draftJson ?? defaultVisualEditorData; setEditorData(data); latestDataRef.current = data; const vh = await api<{ versions: Version[] }>(`/api/admin/visual-editor/pages/${id}/versions`); setVersions(vh.versions); }, [api]);
  useEffect(() => { void loadPages(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const createPage = async () => { setBusy(true); try { const created = await api<Page>("/api/admin/visual-editor/pages", { method: "POST", body: JSON.stringify({ slug: newSlug, title: newTitle, draftJson: defaultVisualEditorData }) }); toast({ title: "Page created", description: created.title }); setPages((p) => [created, ...p]); await loadPage(created.id); } catch (err) { toast({ title: "Create failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" }); } finally { setBusy(false); } };
  const saveDraft = async (data = latestDataRef.current) => { if (!page) return; setBusy(true); try { const saved = await api<Page>(`/api/admin/visual-editor/pages/${page.id}/draft`, { method: "PATCH", body: JSON.stringify({ draftJson: data }) }); setPage(saved); toast({ title: "Draft saved" }); } catch (err) { toast({ title: "Save failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" }); } finally { setBusy(false); } };
  const publish = async (data = latestDataRef.current) => { if (!page) return; setBusy(true); try { await saveDraft(data); const published = await api<Page>(`/api/admin/visual-editor/pages/${page.id}/publish`, { method: "POST" }); setPage(published); await loadPage(published.id); toast({ title: "Page published" }); } catch (err) { toast({ title: "Publish failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" }); } finally { setBusy(false); } };
  const archive = async () => { if (!page) return; setBusy(true); try { const archived = await api<Page>(`/api/admin/visual-editor/pages/${page.id}/archive`, { method: "POST" }); setPage(archived); toast({ title: "Page archived" }); await loadPages(); } finally { setBusy(false); } };
  const restore = async (versionId: number) => { if (!page) return; setBusy(true); try { const restored = await api<Page>(`/api/admin/visual-editor/pages/${page.id}/restore-version`, { method: "POST", body: JSON.stringify({ versionId }) }); setPage(restored); setEditorData(restored.draftJson ?? defaultVisualEditorData); toast({ title: "Version restored" }); } finally { setBusy(false); } };
  const onChange = (data: Data) => { latestDataRef.current = data; setEditorData(data); };
  const previewUrl = useMemo(() => page ? `/admin/visual-editor/${page.id}/preview` : "#", [page]);

  if (loading) return <div className="flex min-h-[50vh] items-center justify-center"><RefreshCw className="mr-2 h-5 w-5 animate-spin" /> Loading visual editor…</div>;
  return <div className="space-y-6">
    <div className="flex flex-col gap-4 lg:flex-row lg:justify-between"><div><h1 className="text-3xl font-bold">Visual Editor</h1><p className="text-sm text-muted-foreground">Safe Puck editor for published pages and catalog/menu presentation. Inventory, orders, checkout, pricing, payments, and permissions are not editable here.</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void loadPages()}><RefreshCw className="mr-2 h-4 w-4" />Reload</Button><Button variant="secondary" disabled={!page || busy} onClick={() => void saveDraft()}><Save className="mr-2 h-4 w-4" />Save draft</Button><Button disabled={!page || busy} onClick={() => void publish()}><Rocket className="mr-2 h-4 w-4" />Publish</Button><Button variant="outline" disabled={!page || busy} onClick={() => window.open(previewUrl, "_blank")}><Eye className="mr-2 h-4 w-4" />Preview</Button><Button variant="destructive" disabled={!page || busy} onClick={() => void archive()}><Archive className="mr-2 h-4 w-4" />Archive</Button></div></div>
    {error ? <Card className="border-destructive/50"><CardHeader><CardTitle className="text-destructive">Error</CardTitle><CardDescription>{error}</CardDescription></CardHeader></Card> : null}
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]"><aside className="space-y-4"><Card><CardHeader><CardTitle>Create page</CardTitle></CardHeader><CardContent className="space-y-2"><Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Title" /><Input value={newSlug} onChange={(e) => setNewSlug(e.target.value)} placeholder="slug" /><Button className="w-full" onClick={() => void createPage()} disabled={busy}><Plus className="mr-2 h-4 w-4" />Create</Button></CardContent></Card><Card><CardHeader><CardTitle>Pages</CardTitle></CardHeader><CardContent className="space-y-2">{pages.length ? pages.map((p) => <Button key={p.id} variant={page?.id === p.id ? "default" : "outline"} className="w-full justify-start" onClick={() => void loadPage(p.id)}>{p.title}</Button>) : <p className="text-sm text-muted-foreground">No pages yet.</p>}</CardContent></Card><Card><CardHeader><CardTitle className="flex items-center gap-2"><History className="h-4 w-4" />Version history</CardTitle></CardHeader><CardContent className="space-y-2">{versions.length ? versions.map((v) => <Button key={v.id} variant="outline" size="sm" className="w-full justify-start" onClick={() => void restore(v.id)}>Restore {new Date(v.createdAt).toLocaleString()}</Button>) : <p className="text-sm text-muted-foreground">Publish to create a version.</p>}</CardContent></Card></aside>
    <main>{!page ? <Card><CardHeader><CardTitle>Empty state</CardTitle><CardDescription>Create a page to begin.</CardDescription></CardHeader></Card> : <Tabs defaultValue="editor"><TabsList><TabsTrigger value="editor">Edit draft</TabsTrigger><TabsTrigger value="draft">Preview draft</TabsTrigger><TabsTrigger value="published">Published</TabsTrigger></TabsList><TabsContent value="editor" className="min-h-[760px] overflow-hidden rounded-xl border"><Puck config={visualEditorConfig} data={editorData} onChange={onChange} onPublish={(data) => void publish(data as Data)} headerTitle={page.title} /></TabsContent><TabsContent value="draft"><div className="rounded-xl border p-4"><Render config={visualEditorConfig} data={editorData} /></div></TabsContent><TabsContent value="published"><div className="rounded-xl border p-4">{page.publishedJson ? <Render config={visualEditorConfig} data={page.publishedJson} /> : <p className="p-8 text-center text-muted-foreground">No published version.</p>}</div></TabsContent></Tabs>}</main></div>
  </div>;
}
