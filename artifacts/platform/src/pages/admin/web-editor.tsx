import { ExternalLink, Globe, Code2, Info } from "lucide-react";

const APP_HOST_PATH = "/plasmic-host";

export default function AdminWebEditor() {
  const appHostUrl = `${window.location.origin}${APP_HOST_PATH}`;

  return (
    <div className="max-w-2xl mx-auto space-y-6 py-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Web Editor</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Visual page editor powered by Plasmic Studio.
        </p>
      </div>

      <div
        className="rounded-2xl p-5 space-y-4"
        style={{ background: "linear-gradient(160deg, hsl(220 42% 11%), hsl(225 40% 9%))", border: "1px solid rgba(59,130,246,0.18)" }}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center shrink-0">
            <Globe size={17} className="text-blue-400" />
          </div>
          <div>
            <div className="text-sm font-bold">Plasmic Studio</div>
            <div className="text-xs text-muted-foreground">Visual drag-and-drop page editor</div>
          </div>
          <a
            href="https://studio.plasmic.app"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-xl text-white"
            style={{ background: "linear-gradient(135deg, #3B82F6, #6366F1)" }}
          >
            Open Studio
            <ExternalLink size={11} />
          </a>
        </div>

        <div className="border-t border-border/30 pt-4 space-y-3">
          <div className="flex items-start gap-2.5">
            <Code2 size={14} className="text-muted-foreground shrink-0 mt-0.5" />
            <div className="space-y-1 min-w-0">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">App Host URL</div>
              <div className="flex items-center gap-2">
                <code
                  className="text-xs font-mono px-2.5 py-1.5 rounded-lg break-all"
                  style={{ background: "rgba(255,255,255,0.06)", color: "#93C5FD", border: "1px solid rgba(59,130,246,0.2)" }}
                >
                  {appHostUrl}
                </code>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(appHostUrl)}
                  className="shrink-0 text-[10px] font-semibold px-2 py-1 rounded-lg border border-border/40 text-muted-foreground hover:text-foreground transition-colors"
                >
                  Copy
                </button>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Paste this URL into Plasmic Studio → Project Settings → App Hosting to connect the editor to this app.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div
        className="rounded-2xl p-4 flex items-start gap-3"
        style={{ background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.15)" }}
      >
        <Info size={15} className="text-blue-400 shrink-0 mt-0.5" />
        <div className="text-xs text-muted-foreground leading-relaxed space-y-1">
          <p>
            Plasmic controls UI shells, landing pages, and visual layouts only.
            Cart, checkout, pricing, auth, inventory, and permissions stay in the platform code.
          </p>
          <p>
            The <code className="font-mono text-blue-400 text-[11px]">/plasmic-host</code> path on this server
            has the correct <code className="font-mono text-blue-400 text-[11px]">Content-Security-Policy</code> headers
            to allow Plasmic Studio to load it in an iframe.
          </p>
        </div>
      </div>
    </div>
  );
}
