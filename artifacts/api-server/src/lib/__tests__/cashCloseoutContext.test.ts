import { describe, expect, it } from "vitest";
import { usesGeneralQueueCashSession } from "../cashCloseoutContext";

describe("cash closeout accountability context", () => {
  it("keeps active CSR and supervisor orders on their assigned shift when another register has a General Queue session", () => {
    expect(usesGeneralQueueCashSession("active_csr", 1)).toBe(false);
    expect(usesGeneralQueueCashSession("supervisor_override", 1)).toBe(false);
    expect(usesGeneralQueueCashSession("active_csr", 2)).toBe(false);
  });

  it("keeps General Queue orders on an open accountable session", () => {
    expect(usesGeneralQueueCashSession("general_account", 1)).toBe(true);
    expect(usesGeneralQueueCashSession("general_account", 2)).toBe(true);
    expect(usesGeneralQueueCashSession("general_account", 0)).toBe(false);
    expect(usesGeneralQueueCashSession(null, 1)).toBe(true);
  });
});
