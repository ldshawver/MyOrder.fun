export function centerText(text: string, width: number): string {
  const s = String(text ?? "");
  if (s.length >= width) return s.slice(0, width);
  const pad = Math.floor((width - s.length) / 2);
  return " ".repeat(pad) + s;
}

export function divider(width: number, char = "="): string {
  return char.repeat(width);
}

export function kvLine(left: string, right: string, width: number): string {
  const l = String(left ?? "");
  const r = String(right ?? "");
  const gap = width - l.length - r.length;
  if (gap <= 0) return (l + " " + r).slice(0, width);
  return l + " ".repeat(gap) + r;
}

export function wrapText(text: string, width: number): string[] {
  const words = String(text ?? "").split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

export function itemLine(
  name: string,
  qty: number | string,
  unitPrice: number | string,
  total: number | string,
  width: number
): string[] {
  const qtyStr = String(qty);
  const totalStr = `$${Number(total ?? 0).toFixed(2)}`;
  const unitStr = `$${Number(unitPrice ?? 0).toFixed(2)}`;
  const prefix = `${qtyStr} x `;
  const suffix = ` ${unitStr}  ${totalStr}`;
  const nameWidth = width - prefix.length - suffix.length;
  const nameStr = String(name ?? "");

  if (nameStr.length <= nameWidth) {
    const gap = nameWidth - nameStr.length;
    return [prefix + nameStr + " ".repeat(gap) + suffix];
  }

  // Name is too long — wrap it
  const firstLine = prefix + nameStr.slice(0, nameWidth) + suffix;
  const rest = nameStr.slice(nameWidth);
  const indent = " ".repeat(prefix.length);
  const wrapped = wrapText(rest, width - indent.length).map(l => indent + l);
  return [firstLine, ...wrapped];
}

export function fitLogo(logoText: string, width: number): string[] {
  return logoText
    .split("\n")
    .map(line => {
      if (line.length <= width) return line;
      return line.slice(0, width);
    });
}

export function money(n: number | string | null | undefined): string {
  return `$${Number(n ?? 0).toFixed(2)}`;
}

export function formatDate(d: string | Date | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export function formatShortDate(d: string | Date | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}
