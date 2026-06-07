import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { Puck, Render, type Data } from "@measured/puck";
import "@measured/puck/puck.css";
import {
  Globe,
  History,
  PlusCircle,
  RefreshCw,
  Rocket,
  Save,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { defaultWebPageData, webEditorConfig } from "@/editor/puckConfig";

type WebPage = {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  status: "draft" | "published" | string;
  draftData: Data;
  publishedData: Data | null;
  updatedAt: string;
  publishedAt: string | null;
  versions?: Array<{ id: number; versionNumber: number; label: string | null; createdAt: string }>;
};

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

export default function AdminWebEditor() {
  const { getToken } = useAuth();

  const [pages, setPages] = useState<WebPage[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [page, setPage] = useState<WebPage | null>(null);
  const [editorData, setEditorData] = useState<Data>(defaultWebPageData);
  const latestDataRef = useRef<Data>(defaultWebPageData);

  const [loadingList, setLoadingList] = useState(true);
  const [loadingPage, setLoadingPage] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  const [showNewForm, setShowNewForm] = useState(false);
  const [newSlug, setNewSlug] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const authHeaders = useCallback(
    async () => {
      const token = await getToken();
      return {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
    },
    [getToken],
  );

  const loadPages = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch("/api/web-editor/pages", { headers: await authHeaders() });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as { pages: WebPage[] };
      setPages(body.pages);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load pages");
    } finally {
      setLoadingList(false);
    }
  }, [authHeaders]);

  useEffect(() => {
    void loadPages();
  }, [loadPages]);

  const loadPage = useCallback(
    async (slug: string) => {
      setLoadingPage(true);
      setError(null);
      setLastSavedAt(null);
      try {
        const res = await fetch(`/api/web-editor/pages/${slug}`, {
          headers: await authHeaders(),
        });
        if (!res.ok) throw new Error(await readError(res));
        const body = (await res.json()) as WebPage;
        const data = (body.draftData as Data) ?? defaultWebPageData;
        setPage(body);
        setEditorData(data);
        latestDataRef.current = data;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load page");
      } finally {
        setLoadingPage(false);
      }
    },
    [authHeaders],
  );

  useEffect(() => {
    if (selectedSlug) void loadPage(selectedSlug);
  }, [selectedSlug, loadPage]);

  const saveDraft = useCallback(
    async (data = latestDataRef.current) => {
      if (!page) return;
      setSaving(true);
      setError(null);
      try {
        const res = await fetch(`/api/web-editor/pages/${page.slug}`, {
          method: "PATCH",
          headers: await authHeaders(),
          body: JSON.stringify({ data }),
        });
        if (!res.ok) throw new Error(await readError(res));
        const body = (await res.json()) as WebPage;
        setPage(body);
        setLastSavedAt(new Date().toLocaleTimeString());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed");
      } finally {
        setSaving(false);
      }
    },
    [page, authHeaders],
  );

  const publish = useCallback(async () => {
    if (!page) return;
    setPublishing(true);
    setError(null);
    try {
      await saveDraft();
      const res = await fetch(`/api/web-editor/pages/${page.slug}/publish`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as WebPage;
      setPage(body);
      setPages((prev) =>
        prev.map((p) => (p.slug === body.slug ? { ...p, status: body.status, publishedAt: body.publishedAt } : p)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setPublishing(false);
    }
  }, [page, authHeaders, saveDraft]);

  const createPage = useCallback(async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/web-editor/pages", {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ slug: newSlug, title: newTitle }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as WebPage;
      setPages((prev) => [body, ...prev]);
      setShowNewForm(false);
      setNewSlug("");
      setNewTitle("");
      setSelectedSlug(body.slug);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }, [authHeaders, newSlug, newTitle]);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tight">Web Editor</h1>
          <p className="text-sm text-muted-foreground">
            Build public marketing pages for MyOrder.fun — Hero, Promos, CTA, FAQ.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowNewForm(true)}>
          <PlusCircle className="mr-2 h-4 w-4" />
          New page
        </Button>
      </div>

      {showNewForm && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Create new page</CardTitle>
            <CardDescription>
              The slug becomes the URL path (e.g. <code>home</code> → <code>/pages/home</code>).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="new-slug">Slug</Label>
                <Input
                  id="new-slug"
                  placeholder="e.g. home"
                  value={newSlug}
                  onChange={(e) => setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="new-title">Title</Label>
                <Input
                  id="new-title"
                  placeholder="e.g. Homepage"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
              </div>
            </div>
            {createError && <p className="mt-2 text-sm text-destructive">{createError}</p>}
            <div className="mt-4 flex gap-2">
              <Button size="sm" onClick={createPage} disabled={creating || !newSlug || !newTitle}>
                {creating ? "Creating…" : "Create"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { setShowNewForm(false); setCreateError(null); }}
              >
                <X className="mr-1.5 h-4 w-4" />
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        {/* Page list */}
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Pages</p>
          {loadingList ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : pages.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No pages yet. Create one above.</p>
          ) : (
            pages.map((p) => (
              <button
                key={p.slug}
                onClick={() => setSelectedSlug(p.slug)}
                className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  selectedSlug === p.slug
                    ? "border-primary bg-primary/5"
                    : "border-transparent bg-muted/30 hover:bg-muted/60"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold">{p.title}</span>
                  <Badge
                    variant={p.status === "published" ? "default" : "secondary"}
                    className="shrink-0 text-[10px]"
                  >
                    {p.status}
                  </Badge>
                </div>
                <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">/{p.slug}</p>
              </button>
            ))
          )}
        </div>

        {/* Editor panel */}
        <div className="min-w-0">
          {!selectedSlug ? (
            <div className="flex h-48 items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">
              Select a page to start editing, or create a new one.
            </div>
          ) : loadingPage ? (
            <div className="flex h-48 items-center justify-center rounded-xl border text-sm text-muted-foreground">
              Loading page…
            </div>
          ) : page ? (
            <div className="flex flex-col gap-4">
              {/* Toolbar */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex-1">
                  <span className="font-bold">{page.title}</span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">/{page.slug}</span>
                  {page.publishedAt && (
                    <span className="ml-3 text-xs text-muted-foreground">
                      Published {new Date(page.publishedAt).toLocaleString()}
                    </span>
                  )}
                  {lastSavedAt && (
                    <span className="ml-3 text-xs text-green-600">Saved {lastSavedAt}</span>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => loadPage(page.slug)}
                  disabled={loadingPage}
                >
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  Refresh
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => saveDraft()}
                  disabled={saving || publishing}
                >
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                  {saving ? "Saving…" : "Save draft"}
                </Button>
                <Button
                  size="sm"
                  onClick={publish}
                  disabled={saving || publishing}
                >
                  <Rocket className="mr-1.5 h-3.5 w-3.5" />
                  {publishing ? "Publishing…" : "Publish"}
                </Button>
              </div>

              {/* Tabs: Edit / Preview / History */}
              <Tabs defaultValue="edit">
                <TabsList>
                  <TabsTrigger value="edit">Edit</TabsTrigger>
                  <TabsTrigger value="preview">
                    <Globe className="mr-1.5 h-3.5 w-3.5" />
                    Preview
                  </TabsTrigger>
                  <TabsTrigger value="history">
                    <History className="mr-1.5 h-3.5 w-3.5" />
                    History
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="edit" className="mt-3">
                  <div className="overflow-hidden rounded-xl border">
                    <Puck
                      config={webEditorConfig}
                      data={editorData}
                      onChange={(data) => {
                        latestDataRef.current = data;
                        setEditorData(data);
                      }}
                      onPublish={async (data) => {
                        latestDataRef.current = data;
                        await saveDraft(data);
                        await publish();
                      }}
                    />
                  </div>
                </TabsContent>

                <TabsContent value="preview" className="mt-3">
                  <div className="rounded-xl border bg-background">
                    <Render config={webEditorConfig} data={editorData} />
                  </div>
                </TabsContent>

                <TabsContent value="history" className="mt-3">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Version history</CardTitle>
                      <CardDescription>
                        Each publish creates a snapshot. Up to 50 versions are kept per page.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {!page.versions || page.versions.length === 0 ? (
                        <p className="text-sm text-muted-foreground italic">
                          No published versions yet. Publish the page to create the first version.
                        </p>
                      ) : (
                        <div className="divide-y divide-border">
                          {page.versions.map((v) => (
                            <div key={v.id} className="flex items-center gap-3 py-3">
                              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                                {v.versionNumber}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium">
                                  {v.label ?? `Version ${v.versionNumber}`}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {new Date(v.createdAt).toLocaleString()}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
