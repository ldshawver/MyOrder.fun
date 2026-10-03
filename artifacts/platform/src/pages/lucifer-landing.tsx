import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { ArrowUpRight, LockKeyhole } from "lucide-react";
import "./lucifer-landing.css";

const CIPHER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*";
const INTRO_MS = 640;
const SWEEP_MS = 1900;
const BOUTIQUE_ROUTE = "/catalog";

type ScanState = { phase: "horizontal" | "vertical" | "done"; y: number; tick: number };

function initialScanState(): ScanState {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? { phase: "done", y: Number.POSITIVE_INFINITY, tick: 0 }
    : { phase: "horizontal", y: -1, tick: 0 };
}

function scramble(text: string, index: number, tick: number): string {
  return text.split("").map((character, position) => {
    if (/\s/.test(character)) return character;
    const value = (position * 37 + index * 23 + tick * 19) % CIPHER.length;
    return CIPHER[value];
  }).join("");
}

function DecodedText({ children, scan, index, className = "" }: {
  children: string;
  scan: ScanState;
  index: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [bounds, setBounds] = useState({ top: Number.POSITIVE_INFINITY, height: 1 });

  useEffect(() => {
    const measure = () => {
      const node = ref.current;
      const page = node?.closest(".lc-landing");
      if (!node || !page) return;
      const nodeRect = node.getBoundingClientRect();
      const pageRect = page.getBoundingClientRect();
      setBounds({ top: nodeRect.top - pageRect.top, height: nodeRect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  const progress = scan.phase === "done"
    ? 1
    : scan.phase === "horizontal"
      ? 0
      : Math.max(0, Math.min(1, (scan.y - bounds.top + 9) / Math.max(22, bounds.height)));
  let letter = 0;
  const visible = children.split("").map((character, position) => {
    if (/\s/.test(character)) return character;
    const resolved = ++letter / Math.max(1, children.replace(/\s/g, "").length) <= progress;
    return resolved ? character : scramble(character, index + position, scan.tick);
  }).join("");

  return (
    <span ref={ref} className={`lc-decode ${className}`}>
      <span className="lc-decode-measure" aria-hidden="true">{children}</span>
      <span className="lc-decode-visible" aria-hidden="true">{visible}</span>
      <span className="lc-decode-screenreader">{children}</span>
    </span>
  );
}

export default function LuciferLanding() {
  const pageRef = useRef<HTMLDivElement>(null);
  const scanRef = useRef<HTMLDivElement>(null);
  const [scan, setScan] = useState<ScanState>(initialScanState);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [, navigate] = useLocation();

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motion.matches) return;
    let frame = 0;
    let started = 0;
    let lastTick = -1;
    const total = INTRO_MS + SWEEP_MS;
    const animate = (now: number) => {
      if (!started) started = now;
      const elapsed = Math.min(now - started, total);
      const pageHeight = pageRef.current?.scrollHeight ?? window.innerHeight;
      const horizontal = elapsed < INTRO_MS;
      const y = horizontal ? 0 : ((elapsed - INTRO_MS) / SWEEP_MS) * pageHeight;
      if (scanRef.current) {
        scanRef.current.style.transform = horizontal
          ? `translate3d(${(-1 + elapsed / INTRO_MS) * 100}%, 0, 0)`
          : `translate3d(0, ${y}px, 0)`;
        scanRef.current.dataset.phase = horizontal ? "horizontal" : "vertical";
      }
      const tick = Math.floor(elapsed / 65);
      if (tick !== lastTick || elapsed === total) {
        setScan(elapsed === total
          ? { phase: "done", y: Number.POSITIVE_INFINITY, tick }
          : { phase: horizontal ? "horizontal" : "vertical", y, tick });
        lastTick = tick;
      }
      if (elapsed < total) frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    const reduce = () => {
      if (!motion.matches) return;
      cancelAnimationFrame(frame);
      setScan({ phase: "done", y: Number.POSITIVE_INFINITY, tick: 0 });
    };
    motion.addEventListener("change", reduce);
    return () => { cancelAnimationFrame(frame); motion.removeEventListener("change", reduce); };
  }, []);

  return (
    <div className="lc-landing" ref={pageRef}>
      <div className="lc-grain" aria-hidden="true" />
      {scan.phase !== "done" && <div ref={scanRef} className="lc-scanner" data-phase="horizontal" aria-hidden="true" />}

      <header className="lc-header">
        <Link href="/" className="lc-identity" aria-label="Lucifer Cruz home">
          <span className="lc-monogram" aria-hidden="true">LC</span>
          <span className="lc-identity-type">
            <span>LUCIFER CRUZ</span>
            <small>ADULT BOUTIQUE · 18+</small>
          </span>
        </Link>
        <nav className="lc-nav" aria-label="Account">
          <Link href="/waitlist">BECOME A MEMBER</Link>
          <Link href="/sign-in" className="lc-nav-signin"><LockKeyhole size={13} aria-hidden="true" /> SIGN IN</Link>
        </nav>
      </header>

      <main className="lc-main">
        <div className="lc-halo" aria-hidden="true" />
        <div className="lc-edition"><DecodedText scan={scan} index={1}>PRIVATE EDITION / 001</DecodedText></div>
        <div className="lc-logo-frame">
          <img src="/lc-logo.webp" alt="Lucifer Cruz" className="lc-logo" width="640" height="180" />
        </div>
        <h1 className="lc-title"><DecodedText scan={scan} index={2}>LUCIFER CRUZ</DecodedText></h1>
        <p className="lc-overline"><DecodedText scan={scan} index={3}>ADULT BOUTIQUE</DecodedText></p>
        <div className="lc-rule" aria-hidden="true" />
        <p className="lc-age"><DecodedText scan={scan} index={4}>YOU MUST BE 18+ TO ENTER THE ADULT BOUTIQUE</DecodedText></p>
        <p className="lc-description">A private invitation to the extraordinary.</p>
        <label className="lc-confirm">
          <input type="checkbox" checked={ageConfirmed} onChange={event => setAgeConfirmed(event.target.checked)} />
          <span className="lc-checkmark" aria-hidden="true" />
          <span>I confirm I am 18 years of age or older</span>
        </label>
        <div className="lc-actions">
          <button
            type="button"
            className="lc-enter"
            disabled={!ageConfirmed}
            onClick={() => navigate(BOUTIQUE_ROUTE)}
            aria-label="Enter Adult Boutique"
          >
            ENTER ADULT BOUTIQUE <ArrowUpRight size={18} aria-hidden="true" />
          </button>
          <div className="lc-secondary-actions">
            <Link href="/waitlist">BECOME A MEMBER <ArrowUpRight size={15} aria-hidden="true" /></Link>
            <Link href="/sign-in">SIGN IN <ArrowUpRight size={15} aria-hidden="true" /></Link>
          </div>
        </div>
      </main>

      <footer className="lc-footer">
        <span>ADULTS ONLY · 18+</span>
        <div><Link href="/terms-of-service">TERMS</Link><Link href="/privacy">PRIVACY</Link></div>
        <span>PRIVATE · DISCREET · CURATED</span>
      </footer>
    </div>
  );
}
