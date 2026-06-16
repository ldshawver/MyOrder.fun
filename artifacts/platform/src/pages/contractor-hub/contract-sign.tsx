import { useParams } from "wouter";
export default function ContractSignPage() { const params = useParams<{ id: string }>(); return <main className="p-6"><h1 className="text-2xl font-bold">Contract Signing</h1><p>Review and sign contract {params.id}. If Documenso is enabled, the embedded signing session appears here.</p></main>; }
