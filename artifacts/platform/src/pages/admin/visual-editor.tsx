import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/react";
import { Puck, Render, type Data } from "@measured/puck";
import "@measured/puck/puck.css";
import { Link, useLocation, useParams } from "wouter";
import { Eye, History, RefreshCw, Rocket, Save, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { defaultVisualEditorData, visualEditorConfig } from "@/visual-editor/puckConfig";

type VisualEditorPage = { id: number; slug: string; title: string; status: string; draftData?: Data; publishedData?: Data | null; updatedAt: string; publishedAt: string | null };
type Version = { id: number; versionNumber: number; createdAt: string; note: string | null };
async function readError(res: Response) { try { const body = await res.json() as { error?: string }; return body.error ?? `${res.status} ${res.statusText}`; } catch { return `${res.status} ${res.statusText}`; } }

export default function AdminVisualEditor() {
  const { getToken } = useAuth();
  const params = useParams<{ pageId?: string }>();
  const [location, navigate] = useLocation();
  const pageId = params.pageId ? Number(params.pageId) : null;
  const previewMode = location.endsWith("/preview");
  const [pages, setPages] = useState<VisualEditorPage[]>([]);
  const [page, setPage] = useState<VisualEditorPage | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [data, setData] = useState<Data>(defaultVisualEditorData);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const headers = useCallback(async () => ({ "Content-Type": "application/json", ...((await getToken()) ? { Authorization: `Bearer ${await getToken()}` } : {}) }), [getToken]);
  const api = useCallback(async (path: string, init: RequestInit = {}) => { const res = await fetch(path, { ...init, headers: { ...(await headers()), ...(init.headers ?? {}) } }); if (!res.ok) throw new Error(await readError(res)); return res.json(); }, [headers]);
  const loadList = useCallback(async () => { setLoading(true); setMessage(null); try { const body = await api("/api/admin/visual-editor/pages"); setPages(body.pages ?? []); } catch (e) { setMessage(e instanceof Error ? e.message : "Could not load pages"); } finally { setLoading(false); } }, [api]);
  const loadPage = useCallback(async () => { if (!pageId) return; setLoading(true); setMessage(null); try { const body = await api(`/api/admin/visual-editor/pages/${pageId}`) as VisualEditorPage; setPage(body); setData(body.draftData ?? defaultVisualEditorData); const versionBody = await api(`/api/admin/visual-editor/pages/${pageId}/versions`); setVersions(versionBody.versions ?? []); } catch (e) { setMessage(e instanceof Error ? e.message : "Could not load page"); } finally { setLoading(false); } }, [api, pageId]);
  useEffect(() => { void (pageId ? loadPage() : loadList()); }, [pageId, loadPage, loadList]);
  const createPage = async () => { setBusy(true); setMessage(null); try { const created = await api("/api/admin/visual-editor/pages", { method: "POST", body: JSON.stringify({ title, slug }) }) as VisualEditorPage; setMessage("Page created"); navigate(`/admin/visual-editor/${created.id}`); } catch (e) { setMessage(e instanceof Error ? e.message : "Create failed"); } finally { setBusy(false); } };
  const saveDraft = async (draft = data) => { if (!pageId) return; setBusy(true); setMessage(null); try { const updated = await api(`/api/admin/visual-editor/pages/${pageId}/draft`, { method: "PATCH", body: JSON.stringify({ data: draft }) }) as VisualEditorPage; setPage(updated); setMessage("Draft saved"); } catch (e) { setMessage(e instanceof Error ? e.message : "Save failed"); } finally { setBusy(false); } };
  const publish = async () => { if (!pageId) return; setBusy(true); setMessage(null); try { await saveDraft(data); const updated = await api(`/api/admin/visual-editor/pages/${pageId}/publish`, { method: "POST" }) as VisualEditorPage; setPage(updated); setMessage("Published"); await loadPage(); } catch (e) { setMessage(e instanceof Error ? e.message : "Publish failed"); } finally { setBusy(false); } };
  const restore = async (versionId: number) => { if (!pageId) return; setBusy(true); try { const updated = await api(`/api/admin/visual-editor/pages/${pageId}/restore-version`, { method: "POST", body: JSON.stringify({ versionId }) }) as VisualEditorPage; setPage(updated); setData(updated.draftData ?? defaultVisualEditorData); setMessage("Version restored to draft"); } catch (e) { setMessage(e instanceof Error ? e.message : "Restore failed"); } finally { setBusy(false); } };
  const sortedPages = useMemo(() => pages, [pages]);

  if (!pageId) return <div className="space-y-6"><Header /><Card><CardHeader><CardTitle>Create page</CardTitle><CardDescription>Slugs cannot overlap protected app routes such as checkout, admin, api, orders, or inventory.</CardDescription></CardHeader><CardContent className="flex flex-col gap-3 md:flex-row"><Input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} /><Input placeholder="slug" value={slug} onChange={(e) => setSlug(e.target.value)} /><Button disabled={busy || !title || !slug} onClick={() => void createPage()}>Create page</Button></CardContent></Card>{message ? <Notice message={message} /> : null}<Card><CardHeader><CardTitle>Pages</CardTitle></CardHeader><CardContent>{loading ? <p>Loading pages…</p> : sortedPages.length === 0 ? <p className="text-muted-foreground">No visual editor pages yet.</p> : <div className="space-y-2">{sortedPages.map((p) => <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><div><p className="font-semibold">{p.title}</p><p className="text-sm text-muted-foreground">/{p.slug} · updated {new Date(p.updatedAt).toLocaleString()} · published {p.publishedAt ? new Date(p.publishedAt).toLocaleString() : "never"}</p></div><div className="flex gap-2"><Badge>{p.status}</Badge><Button asChild variant="outline"><Link href={`/admin/visual-editor/${p.id}`}>Edit draft</Link></Button><Button asChild variant="secondary"><Link href={`/admin/visual-editor/${p.id}/preview`}>Preview draft</Link></Button></div></div>)}</div>}</CardContent></Card></div>;
  if (loading) return <div className="flex min-h-[60vh] items-center justify-center"><RefreshCw className="mr-2 h-5 w-5 animate-spin" /> Loading visual editor…</div>;
  return <div className="space-y-6"><Header page={page} /><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => navigate("/admin/visual-editor")}>Page list</Button><Button variant="secondary" onClick={() => void saveDraft()} disabled={busy}><Save className="mr-2 h-4 w-4" />Save draft</Button><Button onClick={() => void publish()} disabled={busy}><Rocket className="mr-2 h-4 w-4" />Publish</Button><Button asChild variant="outline"><Link href={`/admin/visual-editor/${pageId}/preview`}><Eye className="mr-2 h-4 w-4" />Preview draft</Link></Button></div>{message ? <Notice message={message} /> : null}{previewMode ? <Card><CardHeader><CardTitle>Draft preview</CardTitle></CardHeader><CardContent><Render config={visualEditorConfig} data={data} /></CardContent></Card> : <div className="grid gap-4 xl:grid-cols-[1fr_320px]"><div className="min-h-[760px] overflow-hidden rounded-xl border bg-background"><Puck config={visualEditorConfig} data={data} onChange={(next) => setData(next)} onPublish={(next) => { setData(next as Data); void publish(); }} headerTitle="MyOrder.fun visual editor" permissions={{ delete: true, drag: true, duplicate: true, edit: true, insert: true }} /></div><Card><CardHeader><CardTitle className="flex items-center gap-2"><History className="h-4 w-4" />Version history</CardTitle><CardDescription>Publishing creates immutable versions; restoring copies a version into the draft only.</CardDescription></CardHeader><CardContent className="space-y-2">{versions.length === 0 ? <p className="text-sm text-muted-foreground">No published versions yet.</p> : versions.map((v) => <div key={v.id} className="rounded-lg border p-3"><p className="font-medium">Version {v.versionNumber}</p><p className="text-xs text-muted-foreground">{new Date(v.createdAt).toLocaleString()}</p><Button className="mt-2" size="sm" variant="outline" onClick={() => void restore(v.id)} disabled={busy}>Restore version</Button></div>)}</CardContent></Card></div>}</div>;
}
function Header({ page }: { page?: VisualEditorPage | null }) { return <div><div className="flex flex-wrap items-center gap-2"><h1 className="text-3xl font-bold tracking-tight">Visual Editor</h1><Badge variant="secondary">Puck self-hosted</Badge><Badge variant="outline" className="gap-1"><ShieldCheck className="h-3 w-3" />Admin only</Badge>{page ? <Badge>{page.status}</Badge> : null}</div><p className="mt-2 max-w-3xl text-sm text-muted-foreground">Admins can edit marketing and catalog presentation only. Inventory counts, checkout totals, pricing authority, payments, permissions, ownership, stock reservation, and fulfillment logic remain outside this editor.</p></div>; }
function Notice({ message }: { message: string }) { return <Card><CardContent className="pt-6 text-sm">{message}</CardContent></Card>; }
