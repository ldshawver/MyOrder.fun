import { useEffect, useState } from "react";
import { useParams } from "wouter";

const BASE_API = import.meta.env.BASE_URL.replace(/\/$/, "");

type SigningState = "loading" | "ready" | "expired" | "completed" | "error";

export default function PublicContractSignPage() {
  const params = useParams<{ token: string }>();
  const [state, setState] = useState<SigningState>("loading");
  const [title, setTitle] = useState("Contract");

  useEffect(() => {
    fetch(`${BASE_API}/api/signing/contracts/${params.token}`)
      .then(async (res) => {
        if (res.status === 404) { setState("expired"); return; }
        if (!res.ok) throw new Error("Signing link failed");
        const body = await res.json();
        setTitle(body.contract?.title ?? "Contract");
        setState("ready");
      })
      .catch(() => setState("error"));
  }, [params.token]);

  async function completeSigning() {
    const res = await fetch(`${BASE_API}/api/signing/contracts/${params.token}/complete`, { method: "POST" });
    setState(res.ok ? "completed" : res.status === 404 ? "expired" : "error");
  }

  return <main className="min-h-screen p-6 space-y-4"><h1 className="text-2xl font-bold">Secure Contract Signing</h1>{state === "loading" && <p>Loading secure signing session…</p>}{state === "expired" && <p>This signing link is invalid or expired. Request a new signing email.</p>}{state === "error" && <p>We could not load this signing session. Please contact support.</p>}{state === "ready" && <><p>{title} is ready for signature.</p><button className="rounded bg-primary px-4 py-2 text-primary-foreground" onClick={completeSigning}>Complete signing</button></>}{state === "completed" && <p>Signing complete. The signed contract has been archived in Document Hub.</p>}</main>;
}
