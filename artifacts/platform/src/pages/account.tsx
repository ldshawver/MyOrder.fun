import { useGetCurrentUser } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Shield, Fingerprint } from "lucide-react";
import { Link } from "wouter";

export default function Account() {
  const { data: user, isLoading } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });

  if (isLoading) return <div className="p-8 font-mono text-xs uppercase tracking-widest text-muted-foreground animate-pulse text-center mt-20">Loading profile...</div>;
  if (!user) return null;

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
  );
}
