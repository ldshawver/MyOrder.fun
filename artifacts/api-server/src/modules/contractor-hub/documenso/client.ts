import { validateDocumensoConfig } from "./config";

export type DocumensoRecipientInput = { email: string; name?: string | null; signingOrder?: number };
export class DocumensoClient {
  constructor(private readonly fetchImpl?: typeof fetch) {}
  private config() { const valid = validateDocumensoConfig(); if (!valid.ok) throw new Error(valid.error); return valid.config; }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> { const cfg = this.config(); const res = await (this.fetchImpl ?? fetch)(`${cfg.baseUrl?.replace(/\/$/, "")}${path}`, { ...init, headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", ...(init.headers ?? {}) } }); if (!res.ok) throw new Error(`Documenso request failed (${res.status})`); return res.json() as Promise<T>; }
  async createDocument(input: { title: string; fileName: string; fileBase64?: string }) { return this.request<{ id: string; status?: string }>("/api/v1/documents", { method: "POST", body: JSON.stringify(input) }); }
  async createRecipients(documentId: string, recipients: DocumensoRecipientInput[]) { return this.request<{ recipients: { id: string; email: string }[] }>(`/api/v1/documents/${documentId}/recipients`, { method: "POST", body: JSON.stringify({ recipients }) }); }
  async sendDocument(documentId: string) { return this.request<{ id: string; status: string }>(`/api/v1/documents/${documentId}/send`, { method: "POST" }); }
  async getDocument(documentId: string) { return this.request<{ id: string; status: string; completedAt?: string; downloadUrl?: string }>(`/api/v1/documents/${documentId}`); }
  async downloadCompletedPdf(documentId: string): Promise<Buffer> { const cfg = this.config(); const res = await (this.fetchImpl ?? fetch)(`${cfg.baseUrl?.replace(/\/$/, "")}/api/v1/documents/${documentId}/download`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } }); if (!res.ok) throw new Error(`Documenso download failed (${res.status})`); return Buffer.from(await res.arrayBuffer()); }
}
export const documensoClient = new DocumensoClient();
