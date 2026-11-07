import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/react";
import { ClipboardCheck, PackagePlus, X } from "lucide-react";

type EntityType = "catalog" | "non_catalog";
type FloorLocation = { id: number; name: string; type: string; displayOrder: number };
type FloorItem = {
  entityType: EntityType;
  itemId: number;
  name: string;
  subtitle: string | null;
  unit: string;
  category: string;
  costHint: string | null;
};
type FloorStop = FloorItem & {
  locationId: number;
  locationName: string;
  bookQuantity: string | null;
  hasBalance: boolean;
};
type FloorLine = {
  locationId: number;
  entityType: EntityType;
  itemId: number;
  quantity: string | null;
  outcome: "unchanged" | "corrected" | "opened" | "received" | "skipped";
  attempt: number;
};
type FloorNote = {
  id: number;
  kind: "add_item" | "change_item" | "general";
  body: string;
  itemName: string | null;
  locationName: string | null;
  createdAt: string;
  authorFirstName: string | null;
};
type FloorSummary = { unchanged: number; corrected: number; opened: number; received: number; skipped: number };
type SessionView = {
  session: {
    id: number;
    kind: "count" | "receive";
    scope: "one" | "all" | null;
    locationId: number | null;
    locationName: string | null;
    reference: string | null;
    status: string;
  };
  stops: FloorStop[];
  lines: FloorLine[];
  notes: FloorNote[];
  nextIndex: number;
  summary: FloorSummary;
};
type Sheet = { locations: FloorLocation[]; items: FloorItem[] };
type Program = "count" | "receive";
type NoteKind = FloorNote["kind"];

class FloorRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly sessionId?: number) {
    super(message);
    this.name = "FloorRequestError";
  }
}

async function floorFetch<T>(getToken: () => Promise<string | null>, path: string, init?: RequestInit): Promise<T> {
  const token = await getToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = await response.json().catch(() => ({})) as { error?: string; code?: string; sessionId?: number };
  if (!response.ok) throw new FloorRequestError(body.error ?? "That did not save. Try again.", response.status, body.code, body.sessionId);
  return body as T;
}

function pretty(value: string | null | undefined): string {
  if (value == null || value.trim() === "") return "not counted";
  const negative = value.trim().startsWith("-");
  const raw = negative ? value.trim().slice(1) : value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return value.trim();
  const [whole, fraction = ""] = raw.split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");
  const shown = `${whole.replace(/^0+(?=\d)/, "") || "0"}${trimmedFraction ? `.${trimmedFraction}` : ""}`;
  return negative ? `-${shown}` : shown;
}

function bump(current: string, delta: number): string {
  const base = current.trim() === "" || current.trim() === "." ? 0 : Number(current);
  if (!Number.isFinite(base)) return current;
  const next = Math.max(0, Math.round((base + delta) * 1_000_000) / 1_000_000);
  return String(next);
}

function typedQuantity(value: string, decimals: number): string {
  const cleaned = value.replace(/[^\d.]/g, "");
  const dot = cleaned.indexOf(".");
  if (dot < 0) return cleaned.slice(0, 12);
  const whole = cleaned.slice(0, dot).slice(0, 12);
  const fraction = cleaned.slice(dot + 1).replace(/\./g, "").slice(0, decimals);
  return `${whole}.${fraction}`;
}

function latestLine(lines: FloorLine[], stop: { locationId: number; entityType: string; itemId: number }): FloorLine | null {
  const matches = lines.filter(line => line.locationId === stop.locationId && line.entityType === stop.entityType && line.itemId === stop.itemId);
  return matches.sort((left, right) => right.attempt - left.attempt)[0] ?? null;
}

function noteLabel(kind: NoteKind): string {
  if (kind === "add_item") return "Add an item";
  if (kind === "change_item") return "Change an item";
  return "Note";
}

function outcomeLabel(line: FloorLine): string {
  if (line.outcome === "skipped") return "Skipped";
  if (line.outcome === "unchanged") return `Matches the books (${pretty(line.quantity)})`;
  if (line.outcome === "received") return `Added ${pretty(line.quantity)}`;
  return `Set to ${pretty(line.quantity)}`;
}

export function InventoryFloorLaunch() {
  const { getToken } = useAuth();
  const [program, setProgram] = useState<Program | null>(null);
  const [notes, setNotes] = useState<FloorNote[]>([]);
  const [showNotes, setShowNotes] = useState(false);
  const loadNotes = useCallback(async () => {
    try { setNotes((await floorFetch<{ notes: FloorNote[] }>(getToken, "/api/admin/inventory-floor/notes")).notes); }
    catch { setNotes([]); }
  }, [getToken]);
  useEffect(() => { void loadNotes(); }, [loadNotes]);

  return <section className="space-y-3" aria-label="Inventory on the floor">
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <button type="button" data-testid="take-inventory" className="flex items-center gap-3 rounded-2xl border-2 border-primary/40 bg-primary px-4 py-4 text-left text-primary-foreground shadow-lg shadow-primary/20" onClick={() => setProgram("count")}>
        <ClipboardCheck size={28} />
        <span><span className="block text-lg font-black leading-tight">Take inventory</span><span className="mt-0.5 block text-sm font-medium opacity-80">Count what you see, one spot at a time.</span></span>
      </button>
      <button type="button" data-testid="receive-order" className="flex items-center gap-3 rounded-2xl border-2 border-primary/30 bg-primary/10 px-4 py-4 text-left" onClick={() => setProgram("receive")}>
        <PackagePlus size={28} className="text-primary" />
        <span><span className="block text-lg font-black leading-tight">Receive order</span><span className="mt-0.5 block text-sm font-medium text-muted-foreground">Add a delivery into stock.</span></span>
      </button>
    </div>
    {notes.length > 0 && <div className="rounded-2xl border border-border/50 bg-card/60 p-3">
      <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setShowNotes(open => !open)}>
        <span className="text-sm font-bold">Suggestions from the floor</span>
        <span className="text-xs text-muted-foreground">{showNotes ? "Hide" : `${notes.length}`}</span>
      </button>
      {showNotes && <ul className="mt-3 space-y-2">
        {notes.slice(0, 12).map(note => <li key={note.id} className="rounded-xl bg-muted/40 px-3 py-2 text-sm">
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{noteLabel(note.kind)}{note.locationName ? ` · ${note.locationName}` : ""}{note.authorFirstName ? ` · ${note.authorFirstName}` : ""}</div>
          {note.itemName && <div className="font-semibold">{note.itemName}</div>}
          <div>{note.body}</div>
        </li>)}
      </ul>}
    </div>}
    {program && <FloorProgram program={program} onClose={() => { setProgram(null); void loadNotes(); }} />}
  </section>;
}

function FloorProgram({ program, onClose }: { program: Program; onClose: () => void }) {
  const { getToken } = useAuth();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [phase, setPhase] = useState<"boot" | "resume" | "scope" | "location" | "ticket" | "count" | "pick" | "arrive" | "note" | "done" | "leave">("boot");
  const [scope, setScope] = useState<"one" | "all">("one");
  const [index, setIndex] = useState(0);
  const [travel, setTravel] = useState(false);
  const [editing, setEditing] = useState(false);
  const [needCost, setNeedCost] = useState(false);
  const [draft, setDraft] = useState("");
  const [cost, setCost] = useState("");
  const [reference, setReference] = useState("");
  const [supplier, setSupplier] = useState("");
  const [picked, setPicked] = useState<FloorItem | null>(null);
  const [search, setSearch] = useState("");
  const [noteKind, setNoteKind] = useState<NoteKind>("add_item");
  const [noteBody, setNoteBody] = useState("");
  const [noteReturn, setNoteReturn] = useState<"count" | "pick" | "arrive">("count");
  const [pendingLocationId, setPendingLocationId] = useState<number | null>(null);
  const [doneEarly, setDoneEarly] = useState(false);
  const [returnPhase, setReturnPhase] = useState<"resume" | "location" | "ticket" | "count" | "pick" | "arrive" | "note">("count");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, []);

  const boot = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setBusy(true);
    try {
      const [nextSheet, open] = await Promise.all([
        floorFetch<Sheet>(getToken, "/api/admin/inventory-floor/sheet"),
        floorFetch<{ session: SessionView | null }>(getToken, program === "count" ? "/api/admin/inventory-floor/counts/open" : "/api/admin/inventory-floor/receipts/open"),
      ]);
      setSheet(nextSheet);
      if (open.session) {
        setSession(open.session);
        setIndex(open.session.nextIndex);
        setPhase("resume");
      } else {
        setPhase(program === "count" ? "scope" : "location");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The inventory list could not be loaded.");
    } finally { busyRef.current = false; setBusy(false); }
  }, [getToken, program]);

  useEffect(() => { void boot(); }, [boot]);

  const stop = session?.stops[index] ?? null;
  const saved = stop ? latestLine(session?.lines ?? [], stop) : null;
  const doneCount = useMemo(() => new Set((session?.lines ?? []).map(line => `${line.locationId}:${line.entityType}:${line.itemId}`)).size, [session]);
  const total = session?.stops.length ?? 0;

  function goToCount(view: SessionView, nextIndex = view.nextIndex, announceTravel = false): number | null {
    setSession(view);
    setEditing(false);
    setNeedCost(false);
    setDraft("");
    if (nextIndex >= view.stops.length) return view.session.id;
    const previous = view.stops[nextIndex - 1];
    const upcoming = view.stops[nextIndex];
    setIndex(nextIndex);
    setTravel(announceTravel || Boolean(previous && upcoming && previous.locationId !== upcoming.locationId));
    setPhase("count");
    return null;
  }

  async function completeSession(early: boolean, sessionId: number) {
    const view = await floorFetch<SessionView>(getToken, `/api/admin/inventory-floor/${program === "count" ? "counts" : "receipts"}/${sessionId}/complete`, { method: "POST" });
    setSession(view);
    setDoneEarly(early);
    setPhase("done");
  }

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setBusy(true);
    try { await action(); navigator.vibrate?.(12); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "That did not save."); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function startCount(locationId: number) {
    await run(async () => {
      try {
        const view = await floorFetch<SessionView>(getToken, "/api/admin/inventory-floor/counts", { method: "POST", body: JSON.stringify({ scope, locationId }) });
        const finishedId = goToCount(view);
        if (finishedId) await completeSession(false, finishedId);
      } catch (cause) {
        if (cause instanceof FloorRequestError && cause.code === "SESSION_OPEN" && cause.sessionId) {
          const view = await floorFetch<SessionView>(getToken, `/api/admin/inventory-floor/counts/${cause.sessionId}`);
          const finishedId = goToCount(view);
          if (finishedId) await completeSession(false, finishedId);
          return;
        }
        throw cause;
      }
    });
  }

  async function startReceive(locationId: number) {
    await run(async () => {
      try {
        const view = await floorFetch<SessionView>(getToken, "/api/admin/inventory-floor/receipts", { method: "POST", body: JSON.stringify({ locationId, reference, supplierReference: supplier }) });
        setSession(view);
        setPhase("pick");
      } catch (cause) {
        if (cause instanceof FloorRequestError && cause.code === "SESSION_OPEN" && cause.sessionId) {
          setSession(await floorFetch<SessionView>(getToken, `/api/admin/inventory-floor/receipts/${cause.sessionId}`));
          setPhase("pick");
          return;
        }
        throw cause;
      }
    });
  }

  async function saveCount(unitCost?: string) {
    if (!session || !stop) return;
    const quantity = draft.trim() === "" ? "" : draft.trim();
    if (quantity === "") { setError("Enter how many you see, or tap None here."); return; }
    await run(async () => {
      const attempt = (latestLine(session.lines, stop)?.attempt ?? 0) + 1;
      try {
        const view = await floorFetch<SessionView>(getToken, `/api/admin/inventory-floor/counts/${session.session.id}/lines`, { method: "POST", body: JSON.stringify({ locationId: stop.locationId, entityType: stop.entityType, itemId: stop.itemId, quantity, attempt, unitCost: unitCost ?? null }) });
        const previousLocation = stop.locationId;
        const upcoming = view.stops[view.nextIndex];
        const finishedId = goToCount(view, view.nextIndex, Boolean(upcoming && upcoming.locationId !== previousLocation));
        if (finishedId) await completeSession(false, finishedId);
      } catch (cause) {
        if (cause instanceof FloorRequestError && cause.code === "UNIT_COST_REQUIRED") { setNeedCost(true); setCost(stop.costHint ?? ""); return; }
        throw cause;
      }
    });
  }

  async function skip() {
    if (!session || !stop) return;
    await run(async () => {
      const attempt = (latestLine(session.lines, stop)?.attempt ?? 0) + 1;
      const view = await floorFetch<SessionView>(getToken, `/api/admin/inventory-floor/counts/${session.session.id}/skips`, { method: "POST", body: JSON.stringify({ locationId: stop.locationId, entityType: stop.entityType, itemId: stop.itemId, attempt }) });
      const upcoming = view.stops[view.nextIndex];
      const finishedId = goToCount(view, view.nextIndex, Boolean(upcoming && upcoming.locationId !== stop.locationId));
      if (finishedId) await completeSession(false, finishedId);
    });
  }

  async function saveArrival(unitCost?: string) {
    if (!session || !picked) return;
    if (draft.trim() === "" || draft.trim() === "0") { setError("Enter how many arrived."); return; }
    await run(async () => {
      const attempt = session.lines.filter(line => line.entityType === picked.entityType && line.itemId === picked.itemId && line.outcome === "received").length + 1;
      try {
        const view = await floorFetch<SessionView>(getToken, `/api/admin/inventory-floor/receipts/${session.session.id}/lines`, { method: "POST", body: JSON.stringify({ entityType: picked.entityType, itemId: picked.itemId, quantity: draft.trim(), attempt, unitCost: unitCost ?? cost }) });
        setSession(view);
        setPicked(null);
        setDraft("");
        setNeedCost(false);
        setPhase("pick");
      } catch (cause) {
        if (cause instanceof FloorRequestError && cause.code === "UNIT_COST_REQUIRED") { setNeedCost(true); return; }
        throw cause;
      }
    });
  }

  async function saveNote() {
    if (!session) return;
    const target = program === "count" ? stop : picked;
    await run(async () => {
      await floorFetch(getToken, `/api/admin/inventory-floor/${program === "count" ? "counts" : "receipts"}/${session.session.id}/notes`, { method: "POST", body: JSON.stringify({ kind: noteKind, body: noteBody, locationId: program === "count" ? stop?.locationId ?? session.session.locationId : session.session.locationId, entityType: noteKind === "add_item" ? null : target?.entityType ?? null, itemId: noteKind === "add_item" ? null : target?.itemId ?? null }) });
      const view = await floorFetch<SessionView>(getToken, `/api/admin/inventory-floor/${program === "count" ? "counts" : "receipts"}/${session.session.id}`);
      setSession(view);
      setNoteBody("");
      setPhase(noteReturn);
    });
  }

  async function finish(early: boolean, sessionId = session?.session.id) {
    if (!sessionId) return;
    await run(() => completeSession(early, sessionId));
  }

  async function abandon(then: "restart" | "close" = "restart") {
    if (!session) { onClose(); return; }
    await run(async () => {
      await floorFetch(getToken, `/api/admin/inventory-floor/${program === "count" ? "counts" : "receipts"}/${session.session.id}/abandon`, { method: "POST" });
      setSession(null);
      if (then === "close") onClose();
      else setPhase(program === "count" ? "scope" : "location");
    });
  }

  const title = program === "count" ? "Take inventory" : "Receive order";
  const filteredItems = (sheet?.items ?? []).filter(item => {
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return `${item.name} ${item.subtitle ?? ""} ${item.category}`.toLowerCase().includes(needle);
  });

  return <div className="fixed inset-0 z-[80] flex flex-col bg-background text-foreground">
    <header className="flex items-center gap-3 border-b border-border/50 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
      <button type="button" aria-label="Close" className="flex h-11 w-11 items-center justify-center rounded-full border border-border" onClick={() => { if (phase === "boot" || phase === "scope" || phase === "done" || phase === "leave" || !session || session.session.status !== "open") onClose(); else { if (phase === "resume" || phase === "location" || phase === "ticket" || phase === "count" || phase === "pick" || phase === "arrive" || phase === "note") setReturnPhase(phase); setPhase("leave"); } }}><X size={18} /></button>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{title}</div>
        <div className="truncate text-lg font-black">{phase === "count" && stop ? stop.locationName : phase === "pick" || phase === "arrive" ? session?.session.locationName ?? "Choose a spot" : "On the floor"}</div>
      </div>
    </header>
    {program === "count" && total > 0 && phase === "count" && <div className="px-4 pt-3"><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, Math.round((doneCount / total) * 100))}%` }} /></div><p className="mt-1 text-xs font-semibold text-muted-foreground">{doneCount} of {total} logged</p></div>}
    <div className="flex-1 overflow-y-auto px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
      {error && <div role="alert" className="mb-4 rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-400">{error}</div>}
      {phase === "boot" && <div className="space-y-3"><p className="text-lg font-semibold">{busy ? "Getting the list ready…" : "One moment."}</p>{error && <BigButton disabled={busy} onClick={() => void boot()}>Try again</BigButton>}</div>}
      {phase === "resume" && session && <div className="space-y-3">
        <h2 className="text-3xl font-black leading-tight">Pick up where you left off?</h2>
        <p className="text-base text-muted-foreground">{program === "count" ? `${session.session.scope === "all" ? "Whole shop" : "One spot"} · started at ${session.session.locationName ?? "a location"}. ${doneCount} logged. Counts already saved stay on the books.` : `${session.lines.filter(line => line.outcome === "received").length} item${session.lines.filter(line => line.outcome === "received").length === 1 ? "" : "s"} already added at ${session.session.locationName ?? "the location"}. Anything already added stays in stock.`}</p>
        <BigButton disabled={busy} onClick={() => { if (program !== "count") { setPhase("pick"); return; } if (session.nextIndex >= session.stops.length) void finish(false, session.session.id); else goToCount(session); }}>Continue</BigButton>
        {(program === "count" || !session.lines.some(line => line.outcome === "received")) && <QuietButton disabled={busy} onClick={() => void abandon()}>{program === "count" ? "End this and start over" : "Start over"}</QuietButton>}
      </div>}
      {phase === "scope" && <div className="space-y-3">
        <h2 className="text-3xl font-black leading-tight">One spot, or the whole shop?</h2>
        <Choice title="One location" detail="Count a single spot, then you're done." onClick={() => { setScope("one"); setPhase("location"); }} />
        <Choice title="All locations" detail="We'll ask where to start, then walk the rest." onClick={() => { setScope("all"); setPhase("location"); }} />
      </div>}
      {phase === "location" && <div className="space-y-3">
        <h2 className="text-3xl font-black leading-tight">{program === "count" && scope === "all" ? "Where do you want to start?" : program === "count" ? "Which spot are you counting?" : "Where is this order going?"}</h2>
        {(sheet?.locations ?? []).map(location => <Choice key={location.id} title={location.name} detail={location.type.replace(/_/g, " ")} disabled={busy} onClick={() => { if (program === "count") void startCount(location.id); else { setPendingLocationId(location.id); setPhase("ticket"); } }} />)}
        {(sheet?.locations.length ?? 0) === 0 && <p className="text-sm text-muted-foreground">No active locations yet.</p>}
      </div>}
      {phase === "ticket" && <Ticket reference={reference} supplier={supplier} busy={busy} onReference={setReference} onSupplier={setSupplier} onStart={() => { if (pendingLocationId) void startReceive(pendingLocationId); }} />}
      {phase === "count" && session && stop && (travel ? <Travel session={session} nextName={stop.locationName} busy={busy} onStart={() => setTravel(false)} onFinish={() => void finish(true)} /> : needCost ? <CostPrompt name={stop.name} cost={cost} onCost={setCost} busy={busy} onSave={() => void saveCount(cost)} /> : saved && !editing ? <SavedCount stop={stop} line={saved} busy={busy} onNext={() => { const next = index + 1; if (next >= session.stops.length) { void finish(false); return; } setTravel(session.stops[next]?.locationId !== stop.locationId); setIndex(next); setEditing(false); }} onEdit={() => { setEditing(true); setDraft(saved.quantity ?? ""); }} /> : <CountPrompt stop={stop} index={index} total={total} draft={draft} busy={busy} canSkip={!saved} onDraft={setDraft} onSame={() => setDraft(stop.hasBalance && stop.bookQuantity ? pretty(stop.bookQuantity) : "0")} onZero={() => setDraft("0")} onSave={() => void saveCount()} onSkip={() => void skip()} onNote={() => { setNoteReturn("count"); setNoteKind(saved ? "change_item" : "add_item"); setPhase("note"); }} />)}
      {phase === "pick" && session && <PickList items={filteredItems} catalog={sheet?.items ?? []} lines={session.lines} search={search} reference={session.session.reference} busy={busy} onSearch={setSearch} onPick={item => { setPicked(item); setDraft(""); setCost(item.costHint ?? ""); setNeedCost(false); setPhase("arrive"); }} onNote={() => { setNoteReturn("pick"); setNoteKind("add_item"); setPhase("note"); }} onFinish={() => void finish(false)} onCancel={() => void abandon("close")} />}
      {phase === "arrive" && picked && (needCost ? <CostPrompt name={picked.name} cost={cost} onCost={setCost} busy={busy} onSave={() => void saveArrival(cost)} /> : <ArrivePrompt item={picked} draft={draft} cost={cost} busy={busy} onDraft={setDraft} onCost={setCost} onSave={() => void saveArrival(cost)} onNote={() => { setNoteReturn("arrive"); setNoteKind("change_item"); setPhase("note"); }} onBack={() => setPhase("pick")} />)}
      {phase === "note" && <NotePrompt kind={noteKind} body={noteBody} busy={busy} onKind={setNoteKind} onBody={setNoteBody} onSave={() => void saveNote()} onBack={() => setPhase(noteReturn)} />}
      {phase === "done" && session && <Done program={program} session={session} items={sheet?.items ?? []} early={doneEarly} onClose={onClose} />}
      {phase === "leave" && <div className="space-y-3">
        <h2 className="text-3xl font-black leading-tight">Leave this for later?</h2>
        <p className="text-base text-muted-foreground">What you've already saved stays put. You can pick it up from the inventory page.</p>
        <BigButton onClick={onClose}>Leave for now</BigButton>
        <QuietButton onClick={() => setPhase(returnPhase)}>Keep going</QuietButton>
      </div>}
    </div>
    {phase === "count" && index > 0 && !travel && <footer className="border-t border-border/50 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <button type="button" className="text-sm font-bold text-primary" onClick={() => { setTravel(false); setNeedCost(false); setEditing(false); setIndex(current => Math.max(0, current - 1)); }}>Previous item</button>
    </footer>}
  </div>;
}

function Choice({ title, detail, onClick, disabled, selected }: { title: string; detail: string; onClick: () => void; disabled?: boolean; selected?: boolean }) {
  return <button type="button" disabled={disabled} aria-pressed={selected} className={`w-full rounded-3xl border-2 px-5 py-5 text-left active:scale-[0.99] disabled:opacity-50 ${selected ? "border-primary bg-primary/10" : "border-border bg-card"}`} onClick={onClick}>
    <span className="block text-2xl font-black">{title}</span>
    <span className="mt-1 block text-sm text-muted-foreground">{detail}</span>
  </button>;
}

function BigButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" disabled={disabled} className="h-14 w-full rounded-2xl bg-primary text-lg font-black text-primary-foreground disabled:opacity-50" onClick={onClick}>{children}</button>;
}

function QuietButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" disabled={disabled} className="h-12 w-full rounded-2xl border border-border text-base font-bold disabled:opacity-50" onClick={onClick}>{children}</button>;
}

function CountPrompt({ stop, index, total, draft, busy, canSkip, onDraft, onSame, onZero, onSave, onSkip, onNote }: { stop: FloorStop; index: number; total: number; draft: string; busy: boolean; canSkip: boolean; onDraft: (value: string) => void; onSame: () => void; onZero: () => void; onSave: () => void; onSkip: () => void; onNote: () => void }) {
  const cheer = total <= 0 ? "" : index <= 0 ? "First one. You've got this." : index + 1 === total ? "Last one." : index + 1 === Math.ceil(total / 2) ? "Halfway. Nice pace." : `${index + 1} of ${total}`;
  return <div className="space-y-4">
    <p className="text-sm font-bold text-primary">{cheer}</p>
    <p className="text-sm font-semibold text-muted-foreground">{stop.category}</p>
    <h2 className="text-4xl font-black leading-tight">{stop.name}</h2>
    {stop.subtitle && <p className="text-base text-muted-foreground">{stop.subtitle}</p>}
    <p className="text-base">{stop.hasBalance ? `Books say ${pretty(stop.bookQuantity)} ${stop.unit}.` : "This spot has not been counted yet."}</p>
    <div className="flex items-center gap-3">
      <button type="button" aria-label="Decrease quantity" className="h-16 w-16 rounded-full border-2 text-3xl font-black" onClick={() => onDraft(bump(draft, -1))}>−</button>
      <input key={`${stop.locationId}-${stop.entityType}-${stop.itemId}`} aria-label={`Quantity of ${stop.name}`} inputMode="decimal" autoComplete="off" autoFocus enterKeyHint="done" className="h-20 min-w-0 flex-1 bg-transparent text-center text-5xl font-black outline-none" value={draft} placeholder="0" onChange={event => onDraft(typedQuantity(event.target.value, stop.entityType === "non_catalog" ? 3 : 6))} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); onSave(); } }} />
      <button type="button" aria-label="Increase quantity" className="h-16 w-16 rounded-full border-2 text-3xl font-black" onClick={() => onDraft(bump(draft, 1))}>+</button>
    </div>
    <p className="text-center text-sm text-muted-foreground">{stop.unit}</p>
    <div className="grid grid-cols-2 gap-2">
      <QuietButton disabled={busy || !stop.hasBalance || pretty(stop.bookQuantity).startsWith("-")} onClick={onSame}>Same as the books</QuietButton>
      <QuietButton disabled={busy} onClick={onZero}>None here</QuietButton>
    </div>
    <BigButton disabled={busy} onClick={onSave}>Log it</BigButton>
    <div className="grid grid-cols-2 gap-2">
      {canSkip ? <QuietButton disabled={busy} onClick={onSkip}>Skip for now</QuietButton> : <span />}
      <QuietButton disabled={busy} onClick={onNote}>Leave a note</QuietButton>
    </div>
  </div>;
}

function SavedCount({ stop, line, busy, onNext, onEdit }: { stop: FloorStop; line: FloorLine; busy: boolean; onNext: () => void; onEdit: () => void }) {
  return <div className="space-y-4">
    <p className="text-sm font-bold text-primary">Already logged</p>
    <h2 className="text-4xl font-black leading-tight">{stop.name}</h2>
    <p className="text-xl font-semibold">{outcomeLabel(line)}</p>
    <BigButton disabled={busy} onClick={onNext}>Next item</BigButton>
    <QuietButton disabled={busy} onClick={onEdit}>Count it again</QuietButton>
  </div>;
}

function Travel({ session, nextName, busy, onStart, onFinish }: { session: SessionView; nextName: string; busy: boolean; onStart: () => void; onFinish: () => void }) {
  return <div className="space-y-4">
    <h2 className="text-4xl font-black leading-tight">Walk over to {nextName}.</h2>
    <p className="text-base text-muted-foreground">{session.summary.corrected + session.summary.opened} changed, {session.summary.unchanged} matched, {session.summary.skipped} skipped so far.</p>
    <BigButton disabled={busy} onClick={onStart}>Start {nextName}</BigButton>
    <QuietButton disabled={busy} onClick={onFinish}>Stop this count</QuietButton>
    <p className="text-center text-xs text-muted-foreground">Stop ends the count. The close button keeps it open for later.</p>
  </div>;
}

function CostPrompt({ name, cost, onCost, busy, onSave }: { name: string; cost: string; onCost: (value: string) => void; busy: boolean; onSave: () => void }) {
  return <div className="space-y-4">
    <h2 className="text-3xl font-black leading-tight">What did each {name} cost?</h2>
    <p className="text-base text-muted-foreground">We need a cost before the extra amount can land in stock.</p>
    <input aria-label="Cost each" inputMode="decimal" className="h-16 w-full rounded-2xl border-2 bg-transparent px-4 text-3xl font-black outline-none" value={cost} placeholder="0.00" onChange={event => onCost(event.target.value)} />
    <BigButton disabled={busy || cost.trim() === ""} onClick={onSave}>Save with this cost</BigButton>
  </div>;
}

function Ticket({ reference, supplier, busy, onReference, onSupplier, onStart }: { reference: string; supplier: string; busy: boolean; onReference: (value: string) => void; onSupplier: (value: string) => void; onStart: () => void }) {
  return <div className="space-y-4">
    <h2 className="text-3xl font-black leading-tight">What should we call this order?</h2>
    <label className="block text-sm font-bold">Order name<input maxLength={240} className="mt-1 h-14 w-full rounded-2xl border-2 bg-transparent px-4 text-lg font-semibold outline-none" value={reference} placeholder="Tuesday vendor drop" onChange={event => onReference(event.target.value)} /></label>
    <label className="block text-sm font-bold">Who brought it?<input maxLength={240} className="mt-1 h-14 w-full rounded-2xl border-2 bg-transparent px-4 text-lg font-semibold outline-none" value={supplier} placeholder="Optional" onChange={event => onSupplier(event.target.value)} /></label>
    <BigButton disabled={busy} onClick={onStart}>Start adding items</BigButton>
  </div>;
}

function itemName(catalog: FloorItem[], line: FloorLine): string {
  return catalog.find(item => item.entityType === line.entityType && item.itemId === line.itemId)?.name ?? "Item";
}

function PickList({ items, catalog, lines, search, reference, busy, onSearch, onPick, onNote, onFinish, onCancel }: { items: FloorItem[]; catalog: FloorItem[]; lines: FloorLine[]; search: string; reference: string | null; busy: boolean; onSearch: (value: string) => void; onPick: (item: FloorItem) => void; onNote: () => void; onFinish: () => void; onCancel: () => void }) {
  const received = lines.filter(line => line.outcome === "received");
  return <div className="space-y-3">
    <h2 className="text-3xl font-black leading-tight">{reference?.trim() ? reference : "What's in the order?"}</h2>
    <p className="text-sm text-muted-foreground">{received.length === 0 ? "Tap an item, enter how many arrived, and it's in stock." : `${received.length} added. Tap another, or finish.`}</p>
    {received.length > 0 && <ul className="space-y-1">{received.slice(-4).map(line => <li key={`${line.entityType}-${line.itemId}-${line.attempt}`} className="rounded-xl bg-primary/10 px-3 py-2 text-sm font-semibold">{itemName(catalog, line)} · {outcomeLabel(line)}</li>)}</ul>}
    <input aria-label="Search items" className="sticky top-0 z-10 h-12 w-full rounded-2xl border-2 bg-background px-4 text-base outline-none" value={search} placeholder="Search items" onChange={event => onSearch(event.target.value)} />
    <div className="space-y-2">
      {items.map((item, itemIndex) => <div key={`${item.entityType}-${item.itemId}`} className="space-y-2">
        {(itemIndex === 0 || items[itemIndex - 1]?.category !== item.category) && <h3 className="px-1 pt-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">{item.category}</h3>}
        <button type="button" className="w-full rounded-2xl border border-border px-4 py-4 text-left active:scale-[0.99]" onClick={() => onPick(item)}><span className="block text-lg font-black">{item.name}</span><span className="text-xs text-muted-foreground">{item.subtitle ? `${item.subtitle} · ` : ""}{item.unit}</span></button>
      </div>)}
      {items.length === 0 && <p className="text-sm text-muted-foreground">No items match that search.</p>}
    </div>
    <QuietButton disabled={busy} onClick={onNote}>Suggest an item</QuietButton>
    {received.length === 0 && <QuietButton disabled={busy} onClick={onCancel}>Cancel this order</QuietButton>}
    <BigButton disabled={busy || received.length === 0} onClick={onFinish}>Finish order</BigButton>
  </div>;
}

function ArrivePrompt({ item, draft, cost, busy, onDraft, onCost, onSave, onNote, onBack }: { item: FloorItem; draft: string; cost: string; busy: boolean; onDraft: (value: string) => void; onCost: (value: string) => void; onSave: () => void; onNote: () => void; onBack: () => void }) {
  return <div className="space-y-4">
    <button type="button" className="text-sm font-bold text-primary" onClick={onBack}>Back to the list</button>
    <h2 className="text-4xl font-black leading-tight">{item.name}</h2>
    <p className="text-base text-muted-foreground">How many arrived?</p>
    <div className="flex items-center gap-3">
      <button type="button" aria-label="Decrease quantity" className="h-16 w-16 rounded-full border-2 text-3xl font-black" onClick={() => onDraft(bump(draft, -1))}>−</button>
      <input aria-label={`Quantity of ${item.name} received`} inputMode="decimal" autoFocus enterKeyHint="done" className="h-20 min-w-0 flex-1 bg-transparent text-center text-5xl font-black outline-none" value={draft} placeholder="0" onChange={event => onDraft(typedQuantity(event.target.value, 3))} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); onSave(); } }} />
      <button type="button" aria-label="Increase quantity" className="h-16 w-16 rounded-full border-2 text-3xl font-black" onClick={() => onDraft(bump(draft, 1))}>+</button>
    </div>
    <label className="block text-sm font-bold">Cost each<input aria-label="Cost each" inputMode="decimal" className="mt-1 h-14 w-full rounded-2xl border-2 bg-transparent px-4 text-2xl font-black outline-none" value={cost} placeholder="0.00" onChange={event => onCost(event.target.value)} /></label>
    <BigButton disabled={busy} onClick={onSave}>Add to stock</BigButton>
    <QuietButton disabled={busy} onClick={onNote}>Suggest a change</QuietButton>
  </div>;
}

function NotePrompt({ kind, body, busy, onKind, onBody, onSave, onBack }: { kind: NoteKind; body: string; busy: boolean; onKind: (kind: NoteKind) => void; onBody: (value: string) => void; onSave: () => void; onBack: () => void }) {
  return <div className="space-y-3">
    <h2 className="text-3xl font-black leading-tight">Leave a note</h2>
    <div className="grid gap-2">
      <Choice title="Suggest an item to add" detail="Something that should be stocked." selected={kind === "add_item"} onClick={() => onKind("add_item")} />
      <Choice title="Suggest a change" detail="A name, size, or other item fix." selected={kind === "change_item"} onClick={() => onKind("change_item")} />
      <Choice title="Something else" detail="Any other note for the shop." selected={kind === "general"} onClick={() => onKind("general")} />
    </div>
    <p className="text-sm font-bold">{noteLabel(kind)}</p>
    <textarea aria-label="Note" maxLength={1000} className="min-h-32 w-full rounded-2xl border-2 bg-transparent p-4 text-base outline-none" value={body} placeholder="Type it here" onChange={event => onBody(event.target.value)} />
    <BigButton disabled={busy || body.trim() === ""} onClick={onSave}>Save note</BigButton>
    <QuietButton onClick={onBack}>Back</QuietButton>
  </div>;
}

function Done({ program, session, items, early, onClose }: { program: Program; session: SessionView; items: FloorItem[]; early: boolean; onClose: () => void }) {
  const summary = session.summary;
  const wholeShop = program === "count" && session.session.scope === "all" && !early;
  const received = session.lines.filter(line => line.outcome === "received");
  return <div className="space-y-4">
    <h2 className="text-4xl font-black leading-tight">{program === "count" ? session.stops.length === 0 ? "Nothing to count at that spot." : wholeShop ? "The whole shop is counted." : early ? "Stopped here. What's counted is saved." : "Count saved." : "Order received."}</h2>
    {program === "count" ? <p className="text-base">{summary.corrected + summary.opened} changed, {summary.unchanged} matched the books, {summary.skipped} skipped.</p> : <div className="space-y-2"><p className="text-base">{summary.received} item{summary.received === 1 ? "" : "s"} added{session.session.locationName ? ` at ${session.session.locationName}` : ""}.</p>{received.map(line => <p key={`${line.entityType}-${line.itemId}-${line.attempt}`} className="rounded-xl bg-primary/10 px-3 py-2 text-sm font-semibold">{itemName(items, line)} · {outcomeLabel(line)}</p>)}</div>}
    {session.notes.length > 0 && <div className="space-y-2"><h3 className="font-black">Notes</h3>{session.notes.map(note => <p key={note.id} className="rounded-xl bg-muted/50 px-3 py-2 text-sm"><span className="font-bold">{noteLabel(note.kind)}. </span>{note.body}</p>)}</div>}
    <BigButton onClick={onClose}>Back to inventory</BigButton>
  </div>;
}
