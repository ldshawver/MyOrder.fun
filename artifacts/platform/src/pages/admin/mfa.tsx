import { useState } from "react";
import { useSetupMfa, useVerifyMfa } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { ShieldCheck } from "lucide-react";

export default function MfaSetup() {
  const [step, setStep] = useState<"init" | "verify" | "success">("init");
  const [token, setToken] = useState("");
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const setupMutation = useSetupMfa();
  const verifyMutation = useVerifyMfa();

  const handleBeginSetup = () => {
    setupMutation.mutate(undefined, {
      onSuccess: () => {
        setStep("verify");
      }
    });
  };

  const handleVerify = () => {
    if (token.length < 6) return;
    verifyMutation.mutate(
      { data: { token } },
      {
        onSuccess: (res) => {
          if (res.verified) {
            setStep("success");
            toast({
              title: "MFA Enabled",
              description: "Your account is now protected with two-factor authentication."
            });
            setTimeout(() => setLocation("/account"), 2000);
          } else {
            toast({
              title: "Verification Failed",
              description: "The code provided was invalid. Please try again.",
              variant: "destructive"
            });
          }
        }
      }
    );
  };

  return (
    <div className="max-w-md mx-auto mt-16 space-y-8">
      <div className="text-center">
        <div className="w-16 h-16 bg-primary/10 text-primary rounded-sm flex items-center justify-center mx-auto mb-6">
          <ShieldCheck size={32} />
        </div>
        <h1 className="text-3xl font-bold tracking-tight mb-2" data-testid="text-title">Secure Authenticator</h1>
        <p className="text-muted-foreground" data-testid="text-subtitle">Initialize Multi-Factor Authentication</p>
      </div>

      <Card className="rounded-sm border-border/50 shadow-sm overflow-hidden">
        {step === "init" && (
          <>
            <CardHeader className="bg-muted/10 border-b border-border/50 pb-4 text-center">
              <CardTitle className="text-sm font-semibold uppercase tracking-wider">Device Preparation</CardTitle>
            </CardHeader>
            <CardContent className="p-6">
              <p className="text-sm text-center text-muted-foreground mb-8 leading-relaxed">
                Use an authenticator application (Google Authenticator, Authy, or 1Password) to scan the secure QR code on the next screen.
              </p>
              <Button onClick={handleBeginSetup} className="w-full rounded-sm h-12 font-semibold uppercase tracking-wider text-xs" disabled={setupMutation.isPending} data-testid="button-begin-setup">
                {setupMutation.isPending ? "Generating Token..." : "Generate Secure Token"}
              </Button>
            </CardContent>
          </>
        )}

        {step === "verify" && setupMutation.data && (
          <>
            <CardHeader className="bg-muted/10 border-b border-border/50 pb-4 text-center">
              <CardTitle className="text-sm font-semibold uppercase tracking-wider">Optical Scan</CardTitle>
            </CardHeader>
            <CardContent className="p-6 space-y-8">
              <div className="flex justify-center p-4 bg-white rounded-sm border-4 border-muted">
                {setupMutation.data.qrCodeUrl.startsWith('data:image') ? (
                  <img src={setupMutation.data.qrCodeUrl} alt="QR Code" className="w-48 h-48" data-testid="img-qr-code" />
                ) : (
                  <div className="w-48 h-48 bg-gray-100 flex items-center justify-center text-[10px] font-mono uppercase tracking-widest text-gray-400 text-center p-4 border border-dashed border-gray-300">
                    Image Matrix Pending
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <div className="text-[10px] font-mono font-medium text-muted-foreground uppercase tracking-widest text-center">Manual Entry Hash</div>
                <div className="font-mono text-sm p-3 bg-muted/30 rounded-sm border border-border/50 text-center tracking-widest select-all text-primary" data-testid="text-manual-secret">
                  {setupMutation.data.secret}
                </div>
              </div>

              <div className="space-y-4 pt-6 border-t border-border/50">
                <div className="text-center">
                  <div className="text-[10px] font-mono font-medium text-muted-foreground uppercase tracking-widest mb-3">Verification Token</div>
                  <Input 
                    placeholder="000000" 
                    value={token} 
                    onChange={(e) => setToken(e.target.value.replace(/\D/g, ''))}
                    maxLength={6}
                    className="text-center tracking-[1em] text-2xl font-mono h-16 rounded-sm bg-background border-border/50 focus:border-primary"
                    data-testid="input-token"
                  />
                </div>
                <Button 
                  onClick={handleVerify} 
                  className="w-full rounded-sm h-12 font-semibold uppercase tracking-wider text-xs" 
                  disabled={token.length < 6 || verifyMutation.isPending}
                  data-testid="button-verify"
                >
                  {verifyMutation.isPending ? "Validating..." : "Validate & Lock"}
                </Button>
              </div>
            </CardContent>
          </>
        )}

        {step === "success" && (
          <CardContent className="pt-12 pb-12 text-center space-y-4">
            <div className="w-20 h-20 bg-green-500/10 text-green-500 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            </div>
            <h3 className="text-xl font-bold tracking-tight uppercase" data-testid="text-success-title">Protocol Active</h3>
            <p className="text-sm text-muted-foreground font-mono uppercase tracking-widest">Redirecting to operations...</p>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
