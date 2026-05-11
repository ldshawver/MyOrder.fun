import { useState } from "react";
import { ChevronDown, ChevronUp, Copy, Check, Bug } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface DebugEntry {
  label: string;
  method: string;
  endpoint: string;
  status: number;
  response: unknown;
  timestamp: string;
  _debug?: {
    tenantId?: number;
    actorId?: number;
    actorClerkId?: string;
    actorRole?: string;
    techId?: number;
    techClerkId?: string;
    techRole?: string;
    shiftId?: number;
    inventoryItemsInserted?: number;
    rowsAffected?: {
      inserted?: number;
      updated?: number;
      skipped?: number;
      failed?: number;
    };
  };
}

function StatusBadge({ status }: { status: number }) {
  const color =
    status >= 500 ? "destructive"
    : status >= 400 ? "destructive"
    : status >= 300 ? "secondary"
    : "default";
  return <Badge variant={color} className="font-mono text-xs">{status}</Badge>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 px-2 text-xs gap-1"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function DebugEntryRow({ entry, index }: { entry: DebugEntry; index: number }) {
  const [open, setOpen] = useState(index === 0);

  const res = entry.response as Record<string, unknown> | null;
  const d = entry._debug ?? (res?._debug as DebugEntry["_debug"]);

  const rowsAffected = d?.rowsAffected ?? (res
    ? {
        inserted: typeof res.inserted === "number" ? res.inserted : undefined,
        updated:  typeof res.updated  === "number" ? res.updated  : undefined,
        skipped:  typeof res.skipped  === "number" ? res.skipped  : undefined,
        failed:   typeof res.failed   === "number" ? res.failed   : undefined,
      }
    : undefined);

  const json = JSON.stringify(entry.response, null, 2);

  return (
    <div className="border border-amber-500/30 rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 bg-amber-500/5 hover:bg-amber-500/10 text-left transition-colors"
        onClick={() => setOpen(v => !v)}
      >
        <Bug className="h-3.5 w-3.5 text-amber-400 shrink-0" />
        <span className="font-mono text-xs text-amber-300 shrink-0">{entry.method}</span>
        <span className="font-mono text-xs text-muted-foreground truncate flex-1">{entry.endpoint}</span>
        <StatusBadge status={entry.status} />
        <span className="text-[10px] text-muted-foreground shrink-0">{entry.timestamp}</span>
        {open ? <ChevronUp className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
      </button>

      {open && (
        <div className="px-3 py-3 space-y-3 bg-black/20 text-xs">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            {d?.tenantId !== undefined && (
              <>
                <span className="text-muted-foreground">Tenant ID</span>
                <span className="font-mono text-amber-300">{d.tenantId}</span>
              </>
            )}
            {(d?.actorId ?? d?.techId) !== undefined && (
              <>
                <span className="text-muted-foreground">{d?.actorId !== undefined ? "Actor DB ID" : "Tech DB ID"}</span>
                <span className="font-mono text-amber-300">{d?.actorId ?? d?.techId}</span>
              </>
            )}
            {(d?.actorClerkId ?? d?.techClerkId) && (
              <>
                <span className="text-muted-foreground">Clerk ID</span>
                <span className="font-mono text-amber-300 truncate">{d?.actorClerkId ?? d?.techClerkId}</span>
              </>
            )}
            {(d?.actorRole ?? d?.techRole) && (
              <>
                <span className="text-muted-foreground">Role</span>
                <span className="font-mono text-amber-300">{d?.actorRole ?? d?.techRole}</span>
              </>
            )}
            {d?.shiftId !== undefined && (
              <>
                <span className="text-muted-foreground">Shift ID</span>
                <span className="font-mono text-amber-300">{d.shiftId}</span>
              </>
            )}
            {d?.inventoryItemsInserted !== undefined && (
              <>
                <span className="text-muted-foreground">Inventory rows</span>
                <span className="font-mono text-amber-300">{d.inventoryItemsInserted}</span>
              </>
            )}
          </div>

          {rowsAffected && Object.values(rowsAffected).some(v => v !== undefined) && (
            <div>
              <div className="text-muted-foreground mb-1">DB rows affected</div>
              <div className="flex flex-wrap gap-2">
                {rowsAffected.inserted !== undefined && (
                  <span className="bg-green-500/15 text-green-400 px-2 py-0.5 rounded font-mono">+{rowsAffected.inserted} inserted</span>
                )}
                {rowsAffected.updated !== undefined && (
                  <span className="bg-blue-500/15 text-blue-400 px-2 py-0.5 rounded font-mono">~{rowsAffected.updated} updated</span>
                )}
                {rowsAffected.skipped !== undefined && (
                  <span className="bg-yellow-500/15 text-yellow-400 px-2 py-0.5 rounded font-mono">{rowsAffected.skipped} skipped</span>
                )}
                {rowsAffected.failed !== undefined && rowsAffected.failed > 0 && (
                  <span className="bg-red-500/15 text-red-400 px-2 py-0.5 rounded font-mono">{rowsAffected.failed} failed</span>
                )}
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-muted-foreground">Response JSON</span>
              <CopyButton text={json} />
            </div>
            <pre className="bg-black/40 rounded p-2 text-[11px] font-mono text-green-300 overflow-x-auto max-h-56 leading-relaxed whitespace-pre-wrap break-all">
              {json}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

interface DebugPanelProps {
  entries: DebugEntry[];
  onClear?: () => void;
}

export function DebugPanel({ entries, onClear }: DebugPanelProps) {
  const [panelOpen, setPanelOpen] = useState(true);

  if (entries.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-950/10 overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-amber-500/5 transition-colors"
        onClick={() => setPanelOpen(v => !v)}
      >
        <Bug className="h-4 w-4 text-amber-400" />
        <span className="text-xs font-semibold text-amber-400 tracking-wide uppercase flex-1 text-left">
          Admin Debug — {entries.length} {entries.length === 1 ? "call" : "calls"}
        </span>
        {onClear && (
          <span
            role="button"
            tabIndex={0}
            className="text-[10px] text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-white/10 transition-colors"
            onClick={e => { e.stopPropagation(); onClear(); }}
            onKeyDown={e => { if (e.key === "Enter") { e.stopPropagation(); onClear?.(); } }}
          >
            Clear
          </span>
        )}
        {panelOpen ? <ChevronUp className="h-4 w-4 text-amber-400 shrink-0" /> : <ChevronDown className="h-4 w-4 text-amber-400 shrink-0" />}
      </button>

      {panelOpen && (
        <div className="px-3 pb-3 space-y-2">
          {entries.map((entry, i) => (
            <DebugEntryRow key={i} entry={entry} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}
