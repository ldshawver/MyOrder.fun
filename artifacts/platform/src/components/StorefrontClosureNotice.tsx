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
  const staffPage = /^\/(?:admin|staff)(?:\/|$)/.test(path);
  const pageNotice = JSON.stringify([path, closure.startsAt, closure.endsAt, closure.message]);
  const reopen = new Date(closure.endsAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <>
      <aside role="status" className="relative z-40 border-b border-red-800 bg-red-950 px-4 py-4 text-center text-white">
        <p className="text-2xl font-bold sm:text-3xl">Store closed</p>
        <p className="mx-auto mt-1 max-w-2xl whitespace-pre-wrap break-words text-base sm:text-lg">{closure.message}</p>
        <p className="mt-1 text-sm text-red-100">Scheduled to reopen {reopen}.</p>
      </aside>
      {!staffPage && (
        <Dialog open={dismissed !== pageNotice} onOpenChange={open => { if (!open) setDismissed(pageNotice); }}>
          <DialogContent className="border-red-800 p-6 sm:p-8">
            <DialogTitle className="text-3xl font-bold sm:text-4xl">Store closed</DialogTitle>
            <DialogDescription className="whitespace-pre-wrap break-words text-lg text-foreground">{closure.message}</DialogDescription>
            <p className="text-base">Scheduled to reopen {reopen}.</p>
            <Button onClick={() => setDismissed(pageNotice)}>Continue browsing</Button>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
