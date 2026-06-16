import { useEffect, useState } from "react";
import { Render, type Data } from "@measured/puck";
import { useParams } from "wouter";
import { visualEditorConfig } from "@/visual-editor/puckConfig";

type PublicPageResponse = { title: string; publishedData: Data; publishedAt: string | null };

export default function PublicVisualPage() {
  const { slug } = useParams<{ slug: string }>();
  const [page, setPage] = useState<PublicPageResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "not-found">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/public/pages/${slug}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("not-found");
        return res.json() as Promise<PublicPageResponse>;
      })
      .then((body) => { if (!cancelled) { setPage(body); setStatus("ready"); } })
      .catch(() => { if (!cancelled) setStatus("not-found"); });
    return () => { cancelled = true; };
  }, [slug]);

  if (status === "loading") return <main className="mx-auto max-w-5xl p-8 text-muted-foreground">Loading page…</main>;
  if (status === "not-found" || !page) return <main className="mx-auto max-w-5xl p-8"><h1 className="text-3xl font-bold">Page not found</h1></main>;
  return <main className="mx-auto max-w-5xl space-y-6 p-6 md:p-10"><h1 className="sr-only">{page.title}</h1><Render config={visualEditorConfig} data={page.publishedData} /></main>;
}
