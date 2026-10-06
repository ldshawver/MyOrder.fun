import { useCallback } from "react";
import { useAuth } from "@clerk/react";

export type ApiResult<T = Record<string, unknown>> = { ok: boolean; status: number; body: T };

/** Authenticated JSON calls for the printing admin screens. */
export function usePrintApi() {
  const { getToken } = useAuth();
  const call = useCallback(async <T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<ApiResult<T>> => {
    const token = await getToken();
    const response = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
    });
    const type = response.headers.get("content-type") ?? "";
    const body = type.includes("application/json")
      ? await response.json().catch(() => ({}))
      : type.includes("application/pdf")
        ? { blob: await response.blob() }
        : { text: await response.text() };
    return { ok: response.ok, status: response.status, body: body as T };
  }, [getToken]);
  return call;
}

export const errorText = (body: unknown, fallback: string) =>
  body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : fallback;
