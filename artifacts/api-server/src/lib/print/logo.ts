import fs from "fs";
import path from "path";
import { fitLogo, centerText } from "./formatter";

const LOGO_PATH = path.join(import.meta.dirname, "assets/logo.txt");
const FALLBACK = "ALAVONT THERAPEUTICS";

let _cached: string | null = null;

function loadRaw(): string {
  if (_cached !== null) return _cached;
  try {
    _cached = fs.readFileSync(LOGO_PATH, "utf8");
  } catch {
    _cached = FALLBACK;
  }
  return _cached;
}

export function getLogo(width: number, brandName?: string | null): string[] {
  const raw = loadRaw();
  if (raw === FALLBACK) {
    const name = brandName ?? FALLBACK;
    return [centerText(name, width)];
  }
  const lines = fitLogo(raw, width);
  // If a custom brand name is provided, append it centered below the logo
  if (brandName && brandName !== FALLBACK) {
    lines.push(centerText(brandName.toUpperCase(), width));
  }
  return lines.filter(l => l.trim().length > 0 || l === "");
}
