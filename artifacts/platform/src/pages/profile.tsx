import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import {
  useGetCurrentUser,
  useUpdateCurrentUser,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { MessageSquare, Upload, User as UserIcon } from "lucide-react";

type FeedbackTicket = {
  id: number;
  type: string;
  severity: string;
  status: string;
  priority: boolean;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
};

type FeedbackComment = {
  id: number;
  ticketId: number;
  body: string;
  isInternal: boolean;
  createdAt: string;
};

const PHONE_REGEX = /^\+?[\d\s-]{7,20}$/;

function validatePhone(value: string): string | null {
  if (!value) return null;
  return PHONE_REGEX.test(value)
    ? null
    : "Use E.164 or +? digits/spaces/dashes (7–20 chars).";
}

function validateAvatar(value: string): string | null {
  if (!value) return null;
  return /^https?:\/\//i.test(value) ||
    /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(value)
    ? null
    : "Must be an image URL or uploaded image.";
}

export default function Profile() {
  const qc = useQueryClient();
  const { getToken } = useAuth();
  const {
    data: user,
    isLoading,
    refetch,
  } = useGetCurrentUser({
    query: { queryKey: ["getCurrentUser"] },
  });

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Reset the form whenever the loaded user changes (initial load + after refetch)
  useEffect(() => {
    if (!user) return;
    setFirstName(user.firstName ?? "");
    setLastName(user.lastName ?? "");
    setContactPhone(user.contactPhone ?? "");
    setAvatarUrl(user.avatarUrl ?? "");
    setPhoneError(null);
    setAvatarError(null);
  }, [user]);

  const feedbackQuery = useQuery({
    queryKey: ["mySubmittedFeedback"],
    enabled: !isLoading && Boolean(user),
    queryFn: async () => {
      const token = await getToken();
      const res = await fetch("/api/feedback?mine=true", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load feedback");
      return body as { tickets: FeedbackTicket[]; total: number };
    },
  });

  const commentsQuery = useQuery({
    queryKey: [
      "mySubmittedFeedbackComments",
      feedbackQuery.data?.tickets.map((t) => t.id).join(","),
    ],
    enabled: Boolean(feedbackQuery.data?.tickets.length),
    queryFn: async () => {
      const token = await getToken();
      const entries = await Promise.all(
        (feedbackQuery.data?.tickets ?? []).map(async (ticket) => {
          const res = await fetch(`/api/feedback/${ticket.id}/comments`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const body = await res.json();
          if (!res.ok)
            throw new Error(body.error ?? "Failed to load feedback notes");
          return [
            ticket.id,
            (body.comments ?? []) as FeedbackComment[],
          ] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<number, FeedbackComment[]>;
    },
  });

  const mutation = useUpdateCurrentUser({
    mutation: {
      onSuccess: async () => {
        setSavedMsg("Profile saved.");
        setErrorMsg(null);
        await qc.invalidateQueries({ queryKey: ["getCurrentUser"] });
        await refetch();
      },
      onError: (err: unknown) => {
        const message =
          (err as { data?: { error?: string } })?.data?.error ||
          (err as Error)?.message ||
          "Failed to save profile.";
        setErrorMsg(message);
        setSavedMsg(null);
      },
    },
  });

  if (isLoading) {
    return (
      <div className="p-8 font-mono text-xs uppercase tracking-widest text-muted-foreground animate-pulse text-center mt-20">
        Loading profile...
      </div>
    );
  }
  if (!user) return null;

  const dirty =
    (firstName ?? "") !== (user.firstName ?? "") ||
    (lastName ?? "") !== (user.lastName ?? "") ||
    (contactPhone ?? "") !== (user.contactPhone ?? "") ||
    (avatarUrl ?? "") !== (user.avatarUrl ?? "");

  function reset() {
    if (!user) return;
    setFirstName(user.firstName ?? "");
    setLastName(user.lastName ?? "");
    setContactPhone(user.contactPhone ?? "");
    setAvatarUrl(user.avatarUrl ?? "");
    setPhoneError(null);
    setAvatarError(null);
    setSavedMsg(null);
    setErrorMsg(null);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedPhone = contactPhone.trim();
    const trimmedAvatar = avatarUrl.trim();
    const pErr = validatePhone(trimmedPhone);
    const aErr = validateAvatar(trimmedAvatar);
    setPhoneError(pErr);
    setAvatarError(aErr);
    if (pErr || aErr) return;

    setSavedMsg(null);
    setErrorMsg(null);
    mutation.mutate({
      data: {
        firstName: firstName.trim() || null,
        lastName: lastName.trim() || null,
        contactPhone: trimmedPhone || undefined,
        avatarUrl: trimmedAvatar || undefined,
      },
    });
  }

  function uploadAvatar(file: File | null) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setAvatarError("Choose an image file.");
      return;
    }
    if (file.size > 1_000_000) {
      setAvatarError("Avatar image must be under 1 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setAvatarUrl(String(reader.result ?? ""));
      setAvatarError(null);
    };
    reader.onerror = () => setAvatarError("Could not read avatar image.");
    reader.readAsDataURL(file);
  }

  const initials =
    `${(user.firstName ?? "").charAt(0)}${(user.lastName ?? "").charAt(0)}`.toUpperCase() ||
    "U";

  return (
    <div className="space-y-8 max-w-2xl mx-auto">
      <div className="border-b border-border/50 pb-6">
        <h1
          className="text-3xl font-bold tracking-tight mb-2"
          data-testid="text-profile-title"
        >
          Profile
        </h1>
        <p className="text-muted-foreground">
          Update your name, phone number, and avatar.
        </p>
      </div>

      <Card className="rounded-sm border-border/50 shadow-sm">
        <CardHeader className="bg-muted/10 border-b border-border/50 pb-3 flex flex-row items-center gap-3">
          <UserIcon size={16} className="text-muted-foreground" />
          <CardTitle className="text-sm font-semibold uppercase tracking-wider">
            Profile Details
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-6">
          <form
            onSubmit={onSubmit}
            className="space-y-6"
            data-testid="form-profile"
          >
            <div className="flex items-center gap-4">
              <Avatar className="w-16 h-16">
                {avatarUrl ? (
                  <AvatarImage src={avatarUrl} alt="Avatar preview" />
                ) : null}
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <div className="flex-1">
                <Label
                  htmlFor="avatarUrl"
                  className="text-xs uppercase tracking-wider text-muted-foreground"
                >
                  Avatar URL
                </Label>
                <Input
                  id="avatarUrl"
                  value={avatarUrl}
                  onChange={(e) => {
                    setAvatarUrl(e.target.value);
                    setAvatarError(null);
                  }}
                  placeholder="https://example.com/me.jpg"
                  className="rounded-sm font-mono text-sm h-9 mt-1"
                  data-testid="input-avatar-url"
                />
                <label className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-primary hover:underline cursor-pointer mt-2">
                  <Upload size={12} />
                  Upload image
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    className="sr-only"
                    onChange={(e) => uploadAvatar(e.target.files?.[0] ?? null)}
                    data-testid="input-avatar-file"
                  />
                </label>
                {avatarError && (
                  <p
                    className="text-xs text-destructive mt-1"
                    data-testid="text-avatar-error"
                  >
                    {avatarError}
                  </p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label
                  htmlFor="firstName"
                  className="text-xs uppercase tracking-wider text-muted-foreground"
                >
                  First name
                </Label>
                <Input
                  id="firstName"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="First"
                  className="rounded-sm h-9 mt-1"
                  maxLength={100}
                  data-testid="input-first-name"
                />
              </div>
              <div>
                <Label
                  htmlFor="lastName"
                  className="text-xs uppercase tracking-wider text-muted-foreground"
                >
                  Last name
                </Label>
                <Input
                  id="lastName"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Last"
                  className="rounded-sm h-9 mt-1"
                  maxLength={100}
                  data-testid="input-last-name"
                />
              </div>
            </div>

            <div>
              <Label
                htmlFor="contactPhone"
                className="text-xs uppercase tracking-wider text-muted-foreground"
              >
                Phone number
              </Label>
              <Input
                id="contactPhone"
                value={contactPhone}
                onChange={(e) => {
                  setContactPhone(e.target.value);
                  setPhoneError(null);
                }}
                onBlur={() => setPhoneError(validatePhone(contactPhone.trim()))}
                placeholder="+1 555 000 0000"
                className="rounded-sm font-mono text-sm h-9 mt-1"
                data-testid="input-phone"
              />
              {phoneError && (
                <p
                  className="text-xs text-destructive mt-1"
                  data-testid="text-phone-error"
                >
                  {phoneError}
                </p>
              )}
            </div>

            <div className="text-xs text-muted-foreground">
              Email <span className="font-mono">{user.email}</span> is managed
              by your sign-in provider and cannot be changed here.
            </div>

            {savedMsg && (
              <p
                className="text-xs text-green-600 font-mono"
                data-testid="text-saved"
              >
                {savedMsg}
              </p>
            )}
            {errorMsg && (
              <p
                className="text-xs text-destructive font-mono"
                data-testid="text-error"
              >
                {errorMsg}
              </p>
            )}

            <div className="flex gap-2 pt-2">
              <Button
                type="submit"
                disabled={!dirty || mutation.isPending}
                className="rounded-sm text-xs uppercase tracking-wider font-semibold"
                data-testid="button-save-profile"
              >
                {mutation.isPending ? "Saving…" : "Save"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={reset}
                disabled={!dirty || mutation.isPending}
                className="rounded-sm text-xs uppercase tracking-wider"
                data-testid="button-reset-profile"
              >
                Reset
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="rounded-sm border-border/50 shadow-sm">
        <CardHeader className="bg-muted/10 border-b border-border/50 pb-3 flex flex-row items-center gap-3">
          <MessageSquare size={16} className="text-muted-foreground" />
          <CardTitle className="text-sm font-semibold uppercase tracking-wider">
            My Submitted Feedback
          </CardTitle>
        </CardHeader>
        <CardContent
          className="pt-6 space-y-4"
          data-testid="section-my-feedback"
        >
          {feedbackQuery.isLoading && (
            <p className="text-xs text-muted-foreground">
              Loading submitted feedback…
            </p>
          )}
          {feedbackQuery.isError && (
            <p className="text-xs text-destructive">
              {(feedbackQuery.error as Error).message}
            </p>
          )}
          {!feedbackQuery.isLoading &&
            (feedbackQuery.data?.tickets.length ?? 0) === 0 && (
              <p className="text-xs text-muted-foreground">
                No submitted feedback yet.
              </p>
            )}
          {(feedbackQuery.data?.tickets ?? []).map((ticket) => {
            const publicNotes = (commentsQuery.data?.[ticket.id] ?? []).filter(
              (comment) => !comment.isInternal,
            );
            return (
              <article
                key={ticket.id}
                className="rounded-sm border border-border/60 p-4 space-y-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">
                      #{ticket.id} {ticket.title}
                    </h3>
                    <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      {ticket.type} · {ticket.severity} · submitted{" "}
                      {new Date(ticket.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <span className="rounded-full border border-border px-2 py-1 text-[10px] uppercase tracking-wider" data-testid={`feedback-status-${ticket.id}`}>
                    Status / Result / Outcome: {ticket.status.replaceAll("_", " ")}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                  {ticket.description}
                </p>
                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Public outcome notes
                  </p>
                  {commentsQuery.isLoading && (
                    <p className="text-xs text-muted-foreground">
                      Loading notes…
                    </p>
                  )}
                  {publicNotes.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No public notes yet.
                    </p>
                  )}
                  {publicNotes.map((note) => (
                    <div
                      key={note.id}
                      className="rounded-sm bg-muted/30 p-3 text-sm whitespace-pre-wrap"
                    >
                      {note.body}
                    </div>
                  ))}
                </div>
              </article>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
