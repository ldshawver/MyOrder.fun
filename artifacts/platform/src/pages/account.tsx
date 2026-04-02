import { useGetCurrentUser } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Shield, Fingerprint, Phone } from "lucide-react";
import { Link } from "wouter";
import { useState } from "react";
import { useAuth } from "@clerk/react";

export default function Account() {
  const { data: user, isLoading, refetch } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const { getToken } = useAuth();
  const [phone, setPhone] = useState<string>("");
  const [phoneEditing, setPhoneEditing] = useState(false);
  const [phoneSaving, setPhoneSaving] = useState(false);
  const [phoneMsg, setPhoneMsg] = useState<string | null>(null);

  if (isLoading) return <div className="p-8 font-mono text-xs uppercase tracking-widest text-muted-foreground animate-pulse text-center mt-20">Loading profile...</div>;
  if (!user) return null;

  async function savePhone() {
    setPhoneSaving(true);
    setPhoneMsg(null);
    try {
      const token = await getToken();
      const res = await fetch(`${import.meta.env.BASE_URL}api/users/me/phone`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ contactPhone: phone }),
      });
      if (!res.ok) throw new Error("Failed to save");
      await refetch();
      setPhoneEditing(false);
      setPhoneMsg("Phone number saved.");
    } catch {
      setPhoneMsg("Failed to save phone number.");
    } finally {
      setPhoneSaving(false);
    }
  }

  function startEdit() {
    setPhone(user?.contactPhone ?? "");
    setPhoneEditing(true);
    setPhoneMsg(null);
  }

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
            <CardTitle className="text-sm font-semibold uppercase tracking-wider">Identity Details</CardTitle>
          </CardHeader>
          <CardContent className="pt-6 space-y-6">
            <div>
              <div className="text-[10px] font-mono font-medium text-muted-foreground mb-1 uppercase tracking-widest">Full Name</div>
              <div className="font-medium text-base">{user.firstName} {user.lastName}</div>
            </div>
            <div>
              <div className="text-[10px] font-mono font-medium text-muted-foreground mb-1 uppercase tracking-widest">Email Address</div>
              <div className="font-medium text-base font-mono">{user.email}</div>
            </div>
            <div>
              <div className="text-[10px] font-mono font-medium text-muted-foreground mb-2 uppercase tracking-widest">Assigned Role</div>
              <Badge variant="secondary" className="uppercase text-[10px] tracking-widest px-2 py-0.5 rounded-sm">{user.role.replace('_', ' ')}</Badge>
            </div>
            {user.tenantName && (
              <div className="pt-4 border-t border-border/30">
                <div className="text-[10px] font-mono font-medium text-muted-foreground mb-1 uppercase tracking-widest">Organization</div>
                <div className="font-medium text-base">{user.tenantName}</div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-8">
          {/* Phone Number */}
          <Card className="rounded-sm border-border/50 shadow-sm">
            <CardHeader className="bg-muted/10 border-b border-border/50 pb-3 flex flex-row items-center gap-3">
              <Phone size={16} className="text-muted-foreground" />
              <CardTitle className="text-sm font-semibold uppercase tracking-wider">SMS Notifications</CardTitle>
            </CardHeader>
            <CardContent className="pt-6 space-y-4">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Add your mobile number to receive order confirmations, status updates, and courier tracking links via text message.
              </p>
              {phoneEditing ? (
                <div className="space-y-3">
                  <Input
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                    placeholder="+1 555 000 0000"
                    className="rounded-sm font-mono text-sm h-9"
                    data-testid="input-phone"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={savePhone} disabled={phoneSaving} className="rounded-sm text-xs uppercase tracking-wider font-semibold" data-testid="button-save-phone">
                      {phoneSaving ? "Saving…" : "Save"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setPhoneEditing(false)} className="rounded-sm text-xs uppercase tracking-wider">
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-sm text-foreground">
                    {user.contactPhone || <span className="text-muted-foreground italic">No number on file</span>}
                  </span>
                  <Button size="sm" variant="outline" onClick={startEdit} className="rounded-sm text-xs uppercase tracking-wider shrink-0" data-testid="button-edit-phone">
                    {user.contactPhone ? "Update" : "Add Number"}
                  </Button>
                </div>
              )}
              {phoneMsg && (
                <p className={`text-xs font-mono ${phoneMsg.startsWith("Failed") ? "text-destructive" : "text-green-600"}`}>{phoneMsg}</p>
              )}
            </CardContent>
          </Card>

          {/* Security */}
          <Card className="rounded-sm border-border/50 shadow-sm">
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
              {user.role === 'global_admin' && !user.mfaEnabled && (
                <Button asChild className="w-full rounded-sm font-semibold uppercase tracking-wider text-xs h-10" data-testid="button-setup-mfa">
                  <Link href="/admin/mfa">Initialize MFA Setup</Link>
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
