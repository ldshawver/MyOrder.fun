export type DocumensoConfig = {
  enabled: boolean;
  baseUrl: string | null;
  apiKey: string | null;
};

export function getDocumensoConfig(env: NodeJS.ProcessEnv = process.env): DocumensoConfig {
  const apiKey = env.MYPAYLINK_DOCUMENSO_API_KEY ?? env.MyPayLink_DOCUMENSO_API_KEY ?? null;
  const baseUrl = env.MYPAYLINK_DOCUMENSO_BASE_URL ?? "https://document.luxit.app";
  const enabled = String(env.MYPAYLINK_DOCUMENSO_ENABLED ?? "false").toLowerCase() === "true";
  return { enabled, baseUrl, apiKey };
}

export function validateDocumensoConfig(env: NodeJS.ProcessEnv = process.env): { ok: true; config: DocumensoConfig } | { ok: false; error: string; config: DocumensoConfig } {
  const config = getDocumensoConfig(env);
  if (!config.enabled) return { ok: true, config };
  if (!config.apiKey) {
    return { ok: false, error: "Documenso is not configured. Set MYPAYLINK_DOCUMENSO_API_KEY in environment settings.", config };
  }
  if (!config.baseUrl) {
    return { ok: false, error: "Documenso is not configured. Set MYPAYLINK_DOCUMENSO_BASE_URL in environment settings.", config };
  }
  return { ok: true, config };
}
