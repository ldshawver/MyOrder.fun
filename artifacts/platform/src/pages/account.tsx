import { useGetCurrentUser } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Shield, Fingerprint, User as UserIcon } from "lucide-react";
import { Link } from "wouter";
import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";

export default function Account() {
  const { data: user, isLoading, refetch } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const { getToken } = useAuth();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (user) {
      setFirstName(user.firstName ?? "");
      setLastName(user.lastName ?? "");
      setContactPhone(user.contactPhone ?? "");
      setAvatarUrl(user.avatarUrl ?? "");
    }
  }, [user]);

  if (isLoading) return <div className="p-8 font-mono text-xs uppercase tracking-widest text-muted-foreground animate-pulse text-center mt-20">Loading profile...</div>;
  if (!user) return null;

  const dirty =
    firstName !== (user.firstName ?? "") ||
    lastName !== (user.lastName ?? "") ||
    contactPhone !== (user.contactPhone ?? "") ||
    avatarUrl !== (user.avatarUrl ?? "");

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const token = await getToken();
      const res = await fetch(`${import.meta.env.BASE_URL}api/users/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          firstName: firstName.trim() || null,
          lastName: lastName.trim() || null,
          contactPhone: contactPhone.trim() || null,
          avatarUrl: avatarUrl.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? "Failed to save");
      }
      await refetch();
      setMsg({ kind: "ok", text: "Profile saved." });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Failed to save" });
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setFirstName(user?.firstName ?? "");
    setLastName(user?.lastName ?? "");
    setContactPhone(user?.contactPhone ?? "");
    setAvatarUrl(user?.avatarUrl ?? "");
    setMsg(null);
  }

  const initials = `${(user.firstName ?? "").charAt(0)}${(user.lastName ?? "").charAt(0)}`.toUpperCase() || (user.email ?? "U").charAt(0).toUpperCase();

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      <div className="border-b border-border/50 pb-6">
        <h1 className="text-3xl font-bold tracking-tight mb-2" data-testid="text-title">Account Settings</h1>
        <p className="text-muted-foreground" data-testid="text-subtitle">Manage your profile and security preferences.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <Card className="rounded-sm border-border/50 shadow-sm">
          <CardHeader className="bg-muted/10 border-b border-border/50 pb-3 flex flex-row items-center gap-3">
            <Fingerprint size={16} className="text-muted-foreground" />
            <CardTitle className="text-sm font-semibold uppercase tracking-wider">Profile Details</CardTitle>
          </CardHeader>
          <CardContent className="pt-6 space-y-5">
            <div className="flex items-center gap-4">
              <Avatar className="h-16 w-16 rounded-sm">
                {avatarUrl ? <AvatarImage src={avatarUrl} alt="Profile avatar" /> : null}
                <AvatarFallback className="rounded-sm font-mono text-sm">{initials}</AvatarFallback>
              </Avatar>
              <div className="flex-1">
                <Label htmlFor="avatar-url" className="text-[10px] font-mono font-medium text-muted-foreground mb-1 uppercase tracking-widest block">Avatar URL</Label>
                <Input
                  id="avatar-url"
                  value={avatarUrl}
                  onChange={(e) => setAvatarUrl(e.target.value)}
                  placeholder="https://…/avatar.png"
                  className="rounded-sm font-mono text-xs h-8"
                  data-testid="input-avatar-url"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="first-name" className="text-[10px] font-mono font-medium text-muted-foreground mb-1 uppercase tracking-widest block">First Name</Label>
                <Input
                  id="first-name"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="rounded-sm h-9"
                  data-testid="input-first-name"
                />
              </div>
              <div>
                <Label htmlFor="last-name" className="text-[10px] font-mono font-medium text-muted-foreground mb-1 uppercase tracking-widest block">Last Name</Label>
                <Input
                  id="last-name"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="rounded-sm h-9"
                  data-testid="input-last-name"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="contact-phone" className="text-[10px] font-mono font-medium text-muted-foreground mb-1 uppercase tracking-widest block">Mobile Number (SMS)</Label>
              <Input
                id="contact-phone"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                placeholder="+1 555 000 0000"
                className="rounded-sm font-mono text-sm h-9"
                data-testid="input-phone"
              />
              <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                Used for order confirmations, status updates, and courier tracking links.
              </p>
            </div>

            <div className="border-t border-border/50 pt-4 space-y-3">
              <div>
                <div className="text-[10px] font-mono font-medium text-muted-foreground mb-1 uppercase tracking-widest">Email Address</div>
                <div className="font-medium text-sm font-mono" data-testid="text-email">{user.email}</div>
                <div className="text-[10px] text-muted-foreground mt-1">Managed by your sign-in provider.</div>
              </div>
              <div>
                <div className="text-[10px] font-mono font-medium text-muted-foreground mb-2 uppercase tracking-widest">Assigned Role</div>
                <Badge variant="secondary" className="uppercase text-[10px] tracking-widest px-2 py-0.5 rounded-sm">{user.role.replace(/_/g, " ")}</Badge>
              </div>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <Button
                size="sm"
                onClick={save}
                disabled={!dirty || saving}
                className="rounded-sm text-xs uppercase tracking-wider font-semibold"
                data-testid="button-save-profile"
              >
                {saving ? "Saving…" : "Save Changes"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={reset}
                disabled={!dirty || saving}
                className="rounded-sm text-xs uppercase tracking-wider"
                data-testid="button-reset-profile"
              >
                Reset
              </Button>
              {msg && (
                <span
                  className={`text-xs font-mono ml-2 ${msg.kind === "err" ? "text-destructive" : "text-green-600"}`}
                  data-testid="text-profile-msg"
                >
                  {msg.text}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-sm border-border/50 shadow-sm h-fit">
          <CardHeader className="bg-muted/10 border-b border-border/50 pb-3 flex flex-row items-center gap-3">
            <Shield size={16} className="text-muted-foreground" />
            <CardTitle className="text-sm font-semibold uppercase tracking-wider">Access Security</CardTitle>
          </CardHeader>
          <CardContent className="pt-6 space-y-6">
            <div className={`p-4 border rounded-sm flex items-start gap-4 ${user.mfaEnabled ? 'bg-primary/5 border-primary/20' : 'bg-secondary/10 border-border/50'}`}>
              <div className={`p-2 rounded-sm shrink-0 ${user.mfaEnabled ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}`}>
                <Shield size={20} />
              </div>
              <div>
                <div className="font-semibold text-sm mb-1 uppercase tracking-wider">Multi-Factor Auth</div>
                <div className="text-xs text-muted-foreground leading-relaxed">
                  {user.mfaEnabled ? "MFA is currently active and protecting your session." : "Add an extra layer of security to your authentication flow."}
                </div>
              </div>
            </div>
            {user.role === 'admin' && !user.mfaEnabled && (
              <Button asChild className="w-full rounded-sm font-semibold uppercase tracking-wider text-xs h-10" data-testid="button-setup-mfa">
                <Link href="/admin/mfa">Initialize MFA Setup</Link>
              </Button>
            )}
            <div className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest flex items-center gap-2 pt-2 border-t border-border/50">
              <UserIcon size={12} /> Member since {new Date(user.createdAt).toLocaleDateString()}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
