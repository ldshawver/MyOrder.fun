export interface PrintCheckCompany {
  name: string;
  addressLines: string[];
  phone?: string | null;
  logoUrl?: string | null;
}

export interface PrintCheckBank {
  logoUrl?: string | null;
  name?: string | null;
  address: string;
  fractionTop: string;
  fractionBottom: string;
}

export interface PrintCheckMicr {
  checkNumber: string;
  routingNumber: string;
  accountNumber: string;
}

export interface PrintCheckData {
  company: PrintCheckCompany;
  bank: PrintCheckBank;
  micr: PrintCheckMicr;
}

const MICR_TRANSIT = "⑆";
const MICR_ON_US = "⑈";

export const PRINT_CHECK_CSS = `
.print-check {
  position: relative;
  width: 8.5in;
  min-height: 11in;
  font-family: Arial, Helvetica, sans-serif;
  color: #000;
  background: #fff;
}
.print-check__face {
  position: relative;
  height: 3.42in;
}
.print-check__company {
  position: absolute;
  top: 0.14in;
  left: 0.18in;
  display: grid;
  grid-template-columns: 0.47in auto;
  column-gap: 0.10in;
  align-items: start;
  font-size: 0.14in;
  line-height: 1.15;
}
.print-check__company-logo {
  width: 0.44in;
  max-height: 0.70in;
  object-fit: contain;
  object-position: left top;
}
.print-check__company-name {
  font-weight: 700;
  font-size: 0.17in;
}
.print-check__bank {
  position: absolute;
  top: 0.23in;
  left: 3.05in;
  width: 2.25in;
  text-align: left;
  font-size: 0.11in;
  line-height: 1.12;
}
.print-check__bank-logo {
  display: block;
  width: 2.10in;
  height: 0.22in;
  object-fit: contain;
  object-position: left center;
  margin-bottom: 0.02in;
}
.print-check__bank-name {
  color: #0a2a76;
  font-weight: 800;
  letter-spacing: 0.06in;
  font-size: 0.17in;
  white-space: nowrap;
}
.print-check__fraction {
  position: absolute;
  top: 0.23in;
  left: 5.43in;
  width: 0.78in;
  font-size: 0.12in;
  line-height: 1.05;
}
.print-check__fraction-line {
  border-top: 1px solid #333;
  margin: 0.02in 0;
}
.print-check__micr-clear-band {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 0.625in;
  overflow: hidden;
}
.print-check__micr {
  position: absolute;
  left: 0.42in;
  bottom: 0.18in;
  font-family: "MICR E13B", "GnuMICR", monospace;
  font-size: 0.117in;
  line-height: 0.117in;
  letter-spacing: 0.028in;
  white-space: nowrap;
}
`;

export function formatMicrLine(micr: PrintCheckMicr): string {
  const checkNumber = sanitizeMicrDigits(micr.checkNumber);
  const routingNumber = sanitizeMicrDigits(micr.routingNumber);
  const accountNumber = sanitizeMicrDigits(micr.accountNumber);
  return `${MICR_ON_US}${checkNumber}${MICR_ON_US}   ${MICR_TRANSIT}${routingNumber}${MICR_TRANSIT}   ${accountNumber}${MICR_ON_US}`;
}

export function renderPrintCheckHeader(data: PrintCheckData): string {
  const bankName = data.bank.name?.trim() || "BANK OF AMERICA";
  return `
<style>${PRINT_CHECK_CSS}</style>
<section class="print-check" aria-label="Printable payroll check">
  <div class="print-check__face">
    <div class="print-check__company">
      ${data.company.logoUrl ? `<img class="print-check__company-logo" src="${escapeHtml(data.company.logoUrl)}" alt="${escapeHtml(data.company.name)} logo" />` : `<span class="print-check__company-logo" aria-hidden="true"></span>`}
      <div>
        <div class="print-check__company-name">${escapeHtml(data.company.name)}</div>
        ${data.company.addressLines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
        ${data.company.phone ? `<div>${escapeHtml(data.company.phone)}</div>` : ""}
      </div>
    </div>
    <div class="print-check__bank">
      ${data.bank.logoUrl ? `<img class="print-check__bank-logo" src="${escapeHtml(data.bank.logoUrl)}" alt="${escapeHtml(bankName)} logo" />` : `<div class="print-check__bank-name">${escapeHtml(bankName)}</div>`}
      <div>${escapeHtml(data.bank.address)}</div>
    </div>
    <div class="print-check__fraction" aria-label="Bank fraction number">
      <div>${escapeHtml(data.bank.fractionTop)}</div>
      <div class="print-check__fraction-line"></div>
      <div>${escapeHtml(data.bank.fractionBottom)}</div>
    </div>
    <div class="print-check__micr-clear-band" aria-label="MICR clear band">
      <div class="print-check__micr">${escapeHtml(formatMicrLine(data.micr))}</div>
    </div>
  </div>
</section>`;
}

function sanitizeMicrDigits(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
