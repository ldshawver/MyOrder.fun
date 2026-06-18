/**
 * Admin feedback dashboard.
 *
 * Lists every ticket (admins/supervisors), supports filtering by type,
 * status, priority, assignee, and date range. Selecting a row opens a
 * detail panel where admins can:
 *   - change status (full workflow set)
 *   - toggle the "Priority Fix" flag
 *   - assign an owner from the staff roster
 *   - add internal notes (hidden from the submitter) or public replies
 *
 * Screenshots are loaded lazily via the detail endpoint to keep the list
 * payload small.
 */
import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { useListUsers } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Star, Search, MessageSquare } from "lucide-react";
import { normalizeNotificationRole } from "@/hooks/usePushNotifications";

type Status =
  | "submitted"
  | "reviewed"
  | "in_progress"
  | "implemented"
  | "rejected"
  | "closed"
  | "needs_more_info";
type Type = "bug" | "ux" | "feature" | "general";

const STATUSES: { value: Status; label: string; color: string }[] = [
  {
    value: "submitted",
    label: "Submitted",
    color: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  },
  {
    value: "reviewed",
    label: "Reviewed",
    color: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  },
  {
    value: "in_progress",
    label: "In Progress",
    color: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  },
  {
    value: "implemented",
    label: "Implemented",
    color: "bg-green-500/10 text-green-400 border-green-500/20",
  },
  {
    value: "rejected",
    label: "Rejected",
    color: "bg-red-500/10 text-red-400 border-red-500/20",
  },
  {
    value: "closed",
    label: "Closed",
    color: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  },
  {
    value: "needs_more_info",
    label: "Needs More Info",
    color: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  },
];

const TYPES: { value: Type; label: string }[] = [
  { value: "bug", label: "Bug" },
  { value: "ux", label: "UX" },
  { value: "feature", label: "Feature" },
  { value: "general", label: "General" },
];

type Ticket = {
  id: number;
  type: Type;
  severity: string;
  status: Status;
  priority: boolean;
  title: string;
  description: string;
  pageUrl: string | null;
  userAgent: string | null;
  submitterId: number;
  assigneeId: number | null;
  tenantId: number | null;
  createdAt: string;
  updatedAt: string;
  screenshotData?: string | null;
};

type Comment = {
  id: number;
  ticketId: number;
  authorId: number;
  body: string;
  isInternal: boolean;
  createdAt: string;
};

function StatusBadge({ status }: { status: Status }) {
  const cfg = STATUSES.find((s) => s.value === status) ?? STATUSES[0];
  return (
    <Badge
      variant="outline"
      className={`uppercase text-[9px] tracking-widest px-2 py-0.5 rounded-sm ${cfg.color}`}
    >
      {cfg.label}
    </Badge>
  );
}

export default function AdminFeedback() {
  const queryClient = useQueryClient();
  const { getToken } = useAuth();

  const [filterType, setFilterType] = useState<"all" | Type>("all");
  const [filterStatus, setFilterStatus] = useState<"all" | Status>("all");
  const [filterPriority, setFilterPriority] = useState<"all" | "yes" | "no">(
    "all",
  );
  const [filterAssignee, setFilterAssignee] = useState<
    "all" | "unassigned" | string
  >("all");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [search, setSearch] = useState("");
  const [openTicketId, setOpenTicketId] = useState<number | null>(null);

  const { data: usersData } = useListUsers(
    {},
    { query: { queryKey: ["listUsers"] } },
  );
  const users = useMemo(() => usersData?.users ?? [], [usersData]);
  const userById = useMemo(() => {
    const m = new Map<
      number,
      {
        firstName?: string | null;
        lastName?: string | null;
        email?: string | null;
      }
    >();
    users.forEach((u) => m.set(u.id, u));
    return m;
  }, [users]);
  const staff = useMemo(
    () =>
      users.filter((u) =>
        ["global_admin", "admin", "csr"].includes(
          normalizeNotificationRole(u.role),
        ),
      ),
    [users],
  );

  function userLabel(id: number | null | undefined): string {
    if (!id) return "—";
    const u = userById.get(id);
    if (!u) return `#${id}`;
    return (
      `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email || `#${id}`
    );
  }

  const listQueryKey = useMemo(
    () => [
      "adminFeedback",
      filterType,
      filterStatus,
      filterPriority,
      filterAssignee,
      filterDateFrom,
      filterDateTo,
    ],
    [
      filterType,
      filterStatus,
      filterPriority,
      filterAssignee,
      filterDateFrom,
      filterDateTo,
    ],
  );
  const { data: list, isLoading } = useQuery({
    queryKey: listQueryKey,
    queryFn: async () => {
      const token = await getToken();
      const params = new URLSearchParams();
      if (filterType !== "all") params.set("type", filterType);
      if (filterStatus !== "all") params.set("status", filterStatus);
      if (filterPriority !== "all")
        params.set("priority", filterPriority === "yes" ? "true" : "false");
      if (filterAssignee !== "all" && filterAssignee !== "unassigned")
        params.set("assigneeId", filterAssignee);
      if (filterDateFrom)
        params.set("dateFrom", new Date(filterDateFrom).toISOString());
      if (filterDateTo)
        params.set("dateTo", new Date(filterDateTo).toISOString());
      const res = await fetch(`/api/admin/feedback?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load feedback");
      return res.json() as Promise<{ tickets: Ticket[]; total: number }>;
    },
  });

  const filtered = useMemo(() => {
    let rows = list?.tickets ?? [];
    // "Unassigned" filter is client-side because the API takes assigneeId or
    // nothing — keeps the API surface narrower.
    if (filterAssignee === "unassigned")
      rows = rows.filter((t) => t.assigneeId == null);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          String(t.id).includes(q),
      );
    }
    return rows;
  }, [list, search, filterAssignee]);

  const updateMut = useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: number;
      patch: Partial<{
        status: Status;
        priority: boolean;
        assigneeId: number | null;
      }>;
    }) => {
      const token = await getToken();
      const res = await fetch(`/api/admin/feedback/${id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(patch),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Update failed");
      return body as Ticket;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["adminFeedback"] });
      if (openTicketId != null)
        queryClient.invalidateQueries({
          queryKey: ["adminFeedbackDetail", openTicketId],
        });
    },
  });

  function quickToggle(
    id: number,
    patch: Parameters<typeof updateMut.mutate>[0]["patch"],
  ) {
    updateMut.mutate({ id, patch });
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="border-b border-border/50 pb-6">
        <h1
          className="text-3xl font-bold tracking-tight mb-2"
          data-testid="text-title"
        >
          Feedback &amp; Bug Reports
        </h1>
        <p className="text-muted-foreground">
          Triage incoming reports, assign owners, drive priorities.
        </p>
      </div>

      {/* Filters */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Type
          </label>
          <Select
            value={filterType}
            onValueChange={(v) => setFilterType(v as "all" | Type)}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Status
          </label>
          <Select
            value={filterStatus}
            onValueChange={(v) => setFilterStatus(v as "all" | Status)}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Priority
          </label>
          <Select
            value={filterPriority}
            onValueChange={(v) => setFilterPriority(v as "all" | "yes" | "no")}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="yes">Priority only</SelectItem>
              <SelectItem value="no">Non-priority</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Owner
          </label>
          <Select
            value={filterAssignee}
            onValueChange={(v) => setFilterAssignee(v)}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Anyone</SelectItem>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {staff.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {userLabel(s.id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            From
          </label>
          <Input
            type="date"
            className="h-8 text-xs"
            value={filterDateFrom}
            onChange={(e) => setFilterDateFrom(e.target.value)}
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            To
          </label>
          <Input
            type="date"
            className="h-8 text-xs"
            value={filterDateTo}
            onChange={(e) => setFilterDateTo(e.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <Search
            size={13}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            placeholder="Search title, body, or #id…"
            className="pl-8 h-8 text-xs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className="text-xs text-muted-foreground font-mono">
          {list ? `${filtered.length} / ${list.total}` : ""}
        </span>
      </div>

      <div className="bg-card border border-border/50 rounded-sm shadow-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/10">
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Submitter</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-24 text-center">Priority</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="h-24 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest"
                >
                  Loading tickets…
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="h-24 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest"
                >
                  No tickets match.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((t) => (
                <TableRow
                  key={t.id}
                  className="cursor-pointer hover:bg-muted/20"
                  onClick={() => setOpenTicketId(t.id)}
                  data-testid={`row-feedback-${t.id}`}
                >
                  <TableCell className="font-mono text-xs">{t.id}</TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className="uppercase text-[9px] tracking-widest rounded-sm"
                    >
                      {t.type}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium text-sm max-w-md truncate">
                    {t.title}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {userLabel(t.submitterId)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={t.status} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {userLabel(t.assigneeId)}
                  </TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground">
                    {new Date(t.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-center">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        quickToggle(t.id, { priority: !t.priority });
                      }}
                      className={
                        t.priority
                          ? "text-red-500"
                          : "text-muted-foreground hover:text-red-500"
                      }
                      aria-label="Toggle priority"
                      data-testid={`btn-toggle-priority-${t.id}`}
                    >
                      <Star
                        size={16}
                        fill={t.priority ? "currentColor" : "none"}
                      />
                    </button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {openTicketId != null && (
        <TicketDetailDialog
          ticketId={openTicketId}
          onClose={() => setOpenTicketId(null)}
          userLabel={userLabel}
          staff={staff}
        />
      )}
    </div>
  );
}

function TicketDetailDialog({
  ticketId,
  onClose,
  userLabel,
  staff,
}: {
  ticketId: number;
  onClose: () => void;
  userLabel: (id: number | null | undefined) => string;
  staff: { id: number }[];
}) {
  const queryClient = useQueryClient();
  const { getToken } = useAuth();
  const [comment, setComment] = useState("");
  const [isInternal, setIsInternal] = useState(true);

  const { data: ticket, isLoading } = useQuery({
    queryKey: ["adminFeedbackDetail", ticketId],
    queryFn: async () => {
      const token = await getToken();
      const res = await fetch(`/api/admin/feedback/${ticketId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load ticket");
      return res.json() as Promise<Ticket>;
    },
  });

  const { data: comments } = useQuery({
    queryKey: ["adminFeedbackComments", ticketId],
    queryFn: async () => {
      const token = await getToken();
      const res = await fetch(`/api/admin/feedback/${ticketId}/comments`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load comments");
      return res.json() as Promise<{ comments: Comment[] }>;
    },
  });

  const updateMut = useMutation({
    mutationFn: async (
      patch: Partial<{
        status: Status;
        priority: boolean;
        assigneeId: number | null;
      }>,
    ) => {
      const token = await getToken();
      const res = await fetch(`/api/admin/feedback/${ticketId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("Update failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["adminFeedbackDetail", ticketId],
      });
      queryClient.invalidateQueries({ queryKey: ["adminFeedback"] });
    },
  });

  const commentMut = useMutation({
    mutationFn: async () => {
      const token = await getToken();
      const res = await fetch(`/api/admin/feedback/${ticketId}/comments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: comment.trim(), isInternal }),
      });
      if (!res.ok) throw new Error("Comment failed");
      return res.json();
    },
    onSuccess: () => {
      setComment("");
      queryClient.invalidateQueries({
        queryKey: ["adminFeedbackComments", ticketId],
      });
    },
  });

  return (
    <Dialog
      open={true}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span>#{ticketId}</span>
            <span className="text-base font-normal">
              {ticket?.title ?? (isLoading ? "Loading…" : "")}
            </span>
          </DialogTitle>
        </DialogHeader>

        {ticket && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Status
                </label>
                <Select
                  value={ticket.status}
                  onValueChange={(v) =>
                    updateMut.mutate({ status: v as Status })
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Owner
                </label>
                <Select
                  value={
                    ticket.assigneeId == null
                      ? "_none"
                      : String(ticket.assigneeId)
                  }
                  onValueChange={(v) =>
                    updateMut.mutate({
                      assigneeId: v === "_none" ? null : Number(v),
                    })
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">Unassigned</SelectItem>
                    {staff.map((s) => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        {userLabel(s.id)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Priority Fix
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  className={`h-8 w-full justify-center gap-2 text-xs ${ticket.priority ? "border-red-500/40 text-red-500" : ""}`}
                  onClick={() =>
                    updateMut.mutate({ priority: !ticket.priority })
                  }
                >
                  <Star
                    size={14}
                    fill={ticket.priority ? "currentColor" : "none"}
                  />
                  {ticket.priority ? "Yes" : "Mark"}
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <span className="text-muted-foreground uppercase tracking-wider text-[10px]">
                  Type
                </span>{" "}
                · {ticket.type}
              </div>
              <div>
                <span className="text-muted-foreground uppercase tracking-wider text-[10px]">
                  Severity
                </span>{" "}
                · {ticket.severity}
              </div>
              <div>
                <span className="text-muted-foreground uppercase tracking-wider text-[10px]">
                  Submitter
                </span>{" "}
                · {userLabel(ticket.submitterId)}
              </div>
              <div>
                <span className="text-muted-foreground uppercase tracking-wider text-[10px]">
                  Submitted
                </span>{" "}
                · {new Date(ticket.createdAt).toLocaleString()}
              </div>
              {ticket.pageUrl && (
                <div className="col-span-2 truncate">
                  <span className="text-muted-foreground uppercase tracking-wider text-[10px]">
                    Page
                  </span>{" "}
                  ·{" "}
                  <a
                    href={ticket.pageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline"
                  >
                    {ticket.pageUrl}
                  </a>
                </div>
              )}
              {ticket.userAgent && (
                <div className="col-span-2 truncate text-muted-foreground">
                  <span className="uppercase tracking-wider text-[10px]">
                    UA
                  </span>{" "}
                  · {ticket.userAgent}
                </div>
              )}
            </div>

            <div className="bg-muted/20 rounded-sm p-3 text-sm whitespace-pre-wrap">
              {ticket.description}
            </div>

            {ticket.screenshotData &&
              /^data:image\/(png|jpe?g|gif|webp);base64,/.test(
                ticket.screenshotData,
              ) && (
                <a
                  href={ticket.screenshotData}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    src={ticket.screenshotData}
                    alt="Screenshot"
                    className="max-h-72 rounded-sm border border-border/50"
                  />
                </a>
              )}

            <div>
              <h3 className="text-xs uppercase tracking-wider font-semibold mb-2 flex items-center gap-2">
                <MessageSquare size={13} /> Comments
              </h3>
              <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                {(comments?.comments ?? []).length === 0 && (
                  <div className="text-xs text-muted-foreground italic">
                    No comments yet.
                  </div>
                )}
                {(comments?.comments ?? []).map((c) => (
                  <div
                    key={c.id}
                    className={`p-2 rounded-sm text-sm ${c.isInternal ? "bg-amber-500/10 border border-amber-500/20" : "bg-muted/30"}`}
                  >
                    <div className="text-[10px] font-mono text-muted-foreground mb-1 flex items-center gap-2">
                      <span>{userLabel(c.authorId)}</span>
                      <span>·</span>
                      <span>{new Date(c.createdAt).toLocaleString()}</span>
                      {c.isInternal && (
                        <span className="text-amber-500 uppercase tracking-widest">
                          internal
                        </span>
                      )}
                    </div>
                    <div className="whitespace-pre-wrap">{c.body}</div>
                  </div>
                ))}
              </div>

              <div className="mt-3 space-y-2">
                <Textarea
                  rows={2}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder={
                    isInternal
                      ? "Internal note (admins only)…"
                      : "Reply to submitter…"
                  }
                  className="text-sm"
                />
                <div className="flex items-center justify-between">
                  <label className="text-xs flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={isInternal}
                      onChange={(e) => setIsInternal(e.target.checked)}
                    />
                    Internal note (hidden from submitter)
                  </label>
                  <Button
                    size="sm"
                    onClick={() => commentMut.mutate()}
                    disabled={
                      comment.trim().length === 0 || commentMut.isPending
                    }
                  >
                    {commentMut.isPending ? "Posting…" : "Post"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
