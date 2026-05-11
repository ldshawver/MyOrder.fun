import { describe, it, expect, beforeEach, vi } from "vitest";

const selectMock = vi.fn();
const insertMock = vi.fn();
const loggerInfo = vi.fn();

vi.mock("@workspace/db", () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
  },
  tenantsTable: { id: "id", slug: "slug" },
}));

vi.mock("../logger", () => ({
  logger: { info: (...args: unknown[]) => loggerInfo(...args) },
}));

function chain(result: unknown) {
  const obj: Record<string, unknown> = {};
  const all = ["from", "orderBy", "limit", "values", "onConflictDoNothing", "returning"];
  for (const m of all) obj[m] = vi.fn(() => obj);
  // The terminal awaited call returns the result; simplest is to make every
  // method return `obj` and add a `.then` so awaiting the chain resolves.
  (obj as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(result);
  return obj;
}

async function loadModuleFresh() {
  vi.resetModules();
  return await import("../singleTenant");
}

describe("getHouseTenantId", () => {
  beforeEach(() => {
    selectMock.mockReset();
    insertMock.mockReset();
    loggerInfo.mockReset();
  });

  it("returns the existing tenant id when a row exists", async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 7 }]));
    const { getHouseTenantId } = await loadModuleFresh();
    await expect(getHouseTenantId()).resolves.toBe(7);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("auto-seeds a default tenant when none exists, then returns its id", async () => {
    selectMock.mockReturnValueOnce(chain([])); // initial lookup: empty
    insertMock.mockReturnValueOnce(chain([{ id: 1 }])); // seed returns new id

    const { getHouseTenantId } = await loadModuleFresh();
    await expect(getHouseTenantId()).resolves.toBe(1);
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ event: "tenant_auto_seed" }),
      expect.any(String),
    );
  });

  it("falls back to re-reading after a concurrent-insert conflict", async () => {
    selectMock.mockReturnValueOnce(chain([])); // initial lookup: empty
    insertMock.mockReturnValueOnce(chain([])); // seed returned no row (conflict)
    selectMock.mockReturnValueOnce(chain([{ id: 42 }])); // re-read finds row

    const { getHouseTenantId } = await loadModuleFresh();
    await expect(getHouseTenantId()).resolves.toBe(42);
    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it("throws only when the tenant truly cannot be created or read", async () => {
    selectMock.mockReturnValueOnce(chain([]));
    insertMock.mockReturnValueOnce(chain([]));
    selectMock.mockReturnValueOnce(chain([]));

    const { getHouseTenantId } = await loadModuleFresh();
    await expect(getHouseTenantId()).rejects.toThrow(/auto-seed/i);
  });

  it("caches the tenant id across calls within a process", async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 9 }]));
    const { getHouseTenantId } = await loadModuleFresh();
    await getHouseTenantId();
    await getHouseTenantId();
    await getHouseTenantId();
    expect(selectMock).toHaveBeenCalledTimes(1);
  });
});
