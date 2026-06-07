import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { Puck, Render, type Data } from "@measured/puck";
import "@measured/puck/puck.css";
import { Eye, Lock, RefreshCw, Rocket, Save, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { defaultVisualEditorData, visualEditorConfig } from "@/visual-editor/puckConfig";

const PAGE_SLUG = "workspace";

type VisualEditorPage = {
  id: number;
  slug: string;
  title: string;
  status: "draft" | "published" | string;
  draftData: Data;
  publishedData: Data | null;
  updatedAt: string;
  publishedAt: string | null;
};

async function readError(res: Response) {
  try {
    const body = await res.json() as { error?: string };
    return body.error ?? `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

export default function AdminVisualEditor() {
  const { getToken } = useAuth();
  const [page, setPage] = useState<VisualEditorPage | null>(null);
  const [editorData, setEditorData] = useState<Data>(defaultVisualEditorData);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const latestDataRef = useRef<Data>(defaultVisualEditorData);

  const authHeaders = useCallback(async () => {
    const token = await getToken();
    return {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }, [getToken]);

  const loadPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/visual-editor/pages/${PAGE_SLUG}`, {
        headers: await authHeaders(),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = await res.json() as VisualEditorPage;
      const data = body.draftData ?? defaultVisualEditorData;
      setPage(body);
      setEditorData(data);
      latestDataRef.current = data;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load visual editor data");
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  const saveDraft = useCallback(async (data = latestDataRef.current) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/visual-editor/pages/${PAGE_SLUG}/draft`, {
        method: "PUT",
        headers: await authHeaders(),
        body: JSON.stringify({ data }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = await res.json() as VisualEditorPage;
      setPage(body);
      setLastSavedAt(new Date().toISOString());
      return body;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save draft");
      throw err;
    } finally {
      setSaving(false);
    }
  }, [authHeaders]);

  const publish = useCallback(async (data = latestDataRef.current) => {
    setPublishing(true);
    setError(null);
    try {
      await saveDraft(data);
      const res = await fetch(`/api/admin/visual-editor/pages/${PAGE_SLUG}/publish`, {
        method: "POST",
        headers: await authHeaders(),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = await res.json() as VisualEditorPage;
      setPage(body);
      setLastSavedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not publish layout");
    } finally {
      setPublishing(false);
    }
  }, [authHeaders, saveDraft]);

  const onChange = useCallback((data: Data) => {
    latestDataRef.current = data;
    setEditorData(data);
  }, []);

  const statusLabel = useMemo(() => {
    if (!page) return "Loading";
    if (page.status === "published") return "Published";
    return "Draft preview";
  }, [page]);

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <RefreshCw className="mr-2 h-5 w-5 animate-spin" /> Loading visual editor…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-3xl font-bold tracking-tight">Visual Editor</h1>
            <Badge variant="secondary" className="gap-1"><Lock className="h-3 w-3" /> Self-hosted</Badge>
            <Badge variant="outline" className="gap-1"><ShieldCheck className="h-3 w-3" /> Admin only</Badge>
          </div>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Build private page and layout drafts from approved React components. Layout JSON is saved only to this Postgres-backed API;
            auth, payments, order routing, and permission logic are intentionally not exposed as editable components.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void loadPage()} disabled={saving || publishing}>
            <RefreshCw className="mr-2 h-4 w-4" /> Reload
          </Button>
          <Button variant="secondary" onClick={() => void saveDraft()} disabled={saving || publishing}>
            <Save className="mr-2 h-4 w-4" /> {saving ? "Saving…" : "Save draft"}
          </Button>
          <Button onClick={() => void publish()} disabled={saving || publishing}>
            <Rocket className="mr-2 h-4 w-4" /> {publishing ? "Publishing…" : "Publish"}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">State</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-semibold">{statusLabel}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">Last saved</CardTitle></CardHeader>
          <CardContent><p className="text-sm text-muted-foreground">{lastSavedAt ? new Date(lastSavedAt).toLocaleString() : page?.updatedAt ? new Date(page.updatedAt).toLocaleString() : "Not saved yet"}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">Last published</CardTitle></CardHeader>
          <CardContent><p className="text-sm text-muted-foreground">{page?.publishedAt ? new Date(page.publishedAt).toLocaleString() : "No published version"}</p></CardContent>
        </Card>
      </div>

      {error ? (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardHeader><CardTitle className="text-destructive">Visual editor error</CardTitle><CardDescription>{error}</CardDescription></CardHeader>
        </Card>
      ) : null}

      <Tabs defaultValue="editor" className="space-y-4">
        <TabsList>
          <TabsTrigger value="editor">Editor</TabsTrigger>
          <TabsTrigger value="preview" className="gap-2"><Eye className="h-4 w-4" /> Draft preview</TabsTrigger>
          <TabsTrigger value="published">Published preview</TabsTrigger>
        </TabsList>
        <TabsContent value="editor" className="min-h-[760px] overflow-hidden rounded-xl border bg-background">
          <Puck
            config={visualEditorConfig}
            data={editorData}
            onChange={onChange}
            onPublish={(data) => void publish(data as Data)}
            headerTitle="MyOrder.fun private visual editor"
            permissions={{ delete: true, drag: true, duplicate: true, edit: true, insert: true }}
          />
        </TabsContent>
        <TabsContent value="preview">
          <div className="rounded-xl border bg-background p-4">
            <Render config={visualEditorConfig} data={editorData} />
          </div>
        </TabsContent>
        <TabsContent value="published">
          <div className="rounded-xl border bg-background p-4">
            {page?.publishedData ? (
              <Render config={visualEditorConfig} data={page.publishedData} />
            ) : (
              <p className="p-8 text-center text-muted-foreground">Publish a draft before a published preview is available.</p>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
