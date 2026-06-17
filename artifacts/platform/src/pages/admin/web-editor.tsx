import { Globe, Info } from "lucide-react";

const PUCK_EDITOR_PATH = "/admin/visual-editor";
const PUCK_IMPORT_PATH = "/admin/puck/import";

export default function AdminWebEditor() {
  const editorUrl = `${window.location.origin}${PUCK_EDITOR_PATH}`;

  return (
    <div className="max-w-2xl mx-auto space-y-6 py-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Web Editor</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Visual page editor powered by the tenant-scoped Puck editor.
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
            <div className="text-sm font-bold">Puck Web Editor</div>
            <div className="text-xs text-muted-foreground">Tenant-scoped drag-and-drop page editor</div>
          </div>
          <a
            href={PUCK_EDITOR_PATH}
            className="ml-auto flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-xl text-white"
            style={{ background: "linear-gradient(135deg, #3B82F6, #6366F1)" }}
          >
            Open Puck Editor
          </a>
          <a href={PUCK_IMPORT_PATH} className="flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-xl border border-blue-500/30 text-blue-100">Import Page</a>
        </div>

        <div className="border-t border-border/30 pt-4 space-y-3">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Editor URL</div>
          <code className="text-xs font-mono px-2.5 py-1.5 rounded-lg break-all" style={{ background: "rgba(255,255,255,0.06)", color: "#93C5FD", border: "1px solid rgba(59,130,246,0.2)" }}>
            {editorUrl}
          </code>
          <p className="text-xs text-muted-foreground leading-relaxed">Puck saves draft and published page JSON through the authenticated /api/admin/visual-editor routes.</p>
        </div>
      </div>

      <div
        className="rounded-2xl p-4 flex items-start gap-3"
        style={{ background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.15)" }}
      >
        <Info size={15} className="text-blue-400 shrink-0 mt-0.5" />
        <div className="text-xs text-muted-foreground leading-relaxed space-y-1">
          <p>
            Puck controls UI shells, landing pages, and visual layouts only.
            Cart, checkout, pricing, auth, inventory, and permissions stay in the platform code.
          </p>
          <p>Saved Puck content reloads from the database and remains scoped by tenant and admin permissions.</p>
        </div>
      </div>
    </div>
  );
}
