import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export type ClosureWindow = { startsAt: string; endsAt: string; message: string };
export const storefrontClosureKey = ["public-storefront-closure"];

export function useStorefrontClosure() {
  return useQuery({
    queryKey: storefrontClosureKey,
    refetchInterval: 30_000,
    retry: false,
    queryFn: async (): Promise<ClosureWindow | null> => {
      const response = await fetch("/api/public/storefront-closure", { cache: "no-store" });
      if (!response.ok) throw new Error("Store status unavailable.");
      return (await response.json()).closure;
    },
  });
}

export function StorefrontClosureNotice() {
  const [path] = useLocation();
  const { data: closure } = useStorefrontClosure();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!closure || Date.parse(closure.endsAt) <= Date.now()) return null;
  const pageNotice = JSON.stringify([path, closure.startsAt, closure.endsAt, closure.message]);
  return (
    <Dialog open={dismissed !== pageNotice} onOpenChange={open => { if (!open) setDismissed(pageNotice); }}>
      <DialogContent>
        <DialogTitle>Store closed</DialogTitle>
        <DialogDescription className="whitespace-pre-wrap break-words">{closure.message}</DialogDescription>
        <p className="text-sm">Scheduled to reopen {new Date(closure.endsAt).toLocaleString(undefined, {
          dateStyle: "medium", timeStyle: "short",
        })}.</p>
        <Button onClick={() => setDismissed(pageNotice)}>Continue browsing</Button>
      </DialogContent>
    </Dialog>
  );
}
