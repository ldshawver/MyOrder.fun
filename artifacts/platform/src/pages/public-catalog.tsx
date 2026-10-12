import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, ArrowUpRight, Search } from "lucide-react";
import "./public-catalog.css";

type Product = {
  id: number;
  name: string;
  description: string | null;
  category: string;
  price: number;
  compareAtPrice: number | null;
  imageUrl: string | null;
  isFeatured: boolean;
};
type ProductPage = { items: Product[]; total: number; page: number; limit: number; categories: string[] };
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function hasAgeConfirmation(): boolean {
  try { return sessionStorage.getItem("lc_age_confirmed") === "1"; } catch { return false; }
}

export default function PublicCatalog() {
  const [ageConfirmed, setAgeConfirmed] = useState(hasAgeConfirmation);
  const [page, setPage] = useState(1);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [data, setData] = useState<ProductPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Product | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (selected && dialog && !dialog.open) dialog.showModal();
    if (!selected && dialog?.open) dialog.close();
  }, [selected]);

  useEffect(() => {
    if (!ageConfirmed) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ page: String(page), limit: "12" });
    if (search) query.set("search", search);
    if (category) query.set("category", category);
    setLoading(true);
    setError("");
    fetch(`/api/public/catalog?${query}`, { signal: controller.signal, credentials: "omit" })
      .then(async response => {
        if (!response.ok) throw new Error("The boutique is unavailable right now.");
        return response.json() as Promise<ProductPage>;
      })
      .then(setData)
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "The boutique is unavailable right now."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [ageConfirmed, page, search, category]);

  if (!ageConfirmed) {
    return <main className="pc-age">
      <img src="/lc-logo.webp" alt="Lucifer Cruz" />
      <p>ADULT BOUTIQUE · 18+</p>
      <h1>You must be 18+ to enter the Adult Boutique</h1>
      <button type="button" onClick={() => {
        try { sessionStorage.setItem("lc_age_confirmed", "1"); } catch { /* This visit can still continue. */ }
        setAgeConfirmed(true);
      }}>I AM 18+ · ENTER BOUTIQUE</button>
      <Link href="/">Return to Lucifer Cruz</Link>
    </main>;
  }

  return <div className="pc-page">
    <header className="pc-header">
      <Link href="/" className="pc-back"><ArrowLeft size={16} aria-hidden="true" /> LUCIFER CRUZ</Link>
      <nav aria-label="Account"><Link href="/waitlist">BECOME A MEMBER</Link><Link href="/sign-in">SIGN IN</Link></nav>
    </header>
    <main className="pc-main">
      <div className="pc-heading">
        <span>CURATED FOR THE CURIOUS · 18+</span>
        <h1>THE ADULT BOUTIQUE</h1>
        <p>Explore the Lucifer Cruz collection.</p>
      </div>
      <form className="pc-filters" onSubmit={event => { event.preventDefault(); setPage(1); setSearch(searchDraft.trim()); }}>
        <label>
          <span className="pc-screenreader">Search products</span>
          <Search size={18} aria-hidden="true" />
          <input value={searchDraft} onChange={event => setSearchDraft(event.target.value)} maxLength={100} placeholder="Search the collection" />
        </label>
        <button type="submit">SEARCH</button>
        <label>
          <span className="pc-screenreader">Category</span>
          <select value={category} onChange={event => { setCategory(event.target.value); setPage(1); }}>
            <option value="">ALL CATEGORIES</option>
            {(data?.categories ?? []).map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </form>
      {error && <p className="pc-status" role="alert">{error}</p>}
      {loading && <p className="pc-status" role="status">Loading the collection…</p>}
      {!loading && !error && data?.items.length === 0 && <p className="pc-status">No products match this selection.</p>}
      <div className="pc-grid">
        {(data?.items ?? []).map(product => <button
          key={product.id} type="button" className="pc-card" data-testid="public-product-card"
          onClick={() => setSelected(product)} aria-label={`View ${product.name}`}
        >
          <div className="pc-image">{product.imageUrl ? <img src={product.imageUrl} alt="" loading="lazy" /> : <span>LC</span>}</div>
          <span className="pc-category">{product.category}</span>
          <span className="pc-name">{product.name}</span>
          <span className="pc-price">{money.format(product.price)} <ArrowUpRight size={16} aria-hidden="true" /></span>
        </button>)}
      </div>
      {data && data.total > data.limit && <nav className="pc-pagination" aria-label="Product pages">
        <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}>PREVIOUS</button>
        <span>PAGE {page} OF {Math.ceil(data.total / data.limit)}</span>
        <button type="button" disabled={page * data.limit >= data.total || loading} onClick={() => setPage(value => value + 1)}>NEXT</button>
      </nav>}
    </main>
    <footer className="pc-footer"><span>ADULTS ONLY · 18+</span><Link href="/waitlist">BECOME A MEMBER</Link><Link href="/sign-in">SIGN IN</Link></footer>
    <dialog ref={dialogRef} className="pc-dialog" onClose={() => setSelected(null)} aria-label={selected?.name || "Product details"}>
      {selected && <>
        <button type="button" className="pc-close" onClick={() => setSelected(null)} aria-label="Close product details">×</button>
        {selected.imageUrl && <img src={selected.imageUrl} alt="" />}
        <span className="pc-category">{selected.category}</span>
        <h2>{selected.name}</h2>
        <strong>{money.format(selected.price)}</strong>
        {selected.description && <p>{selected.description}</p>}
      </>}
    </dialog>
  </div>;
}
