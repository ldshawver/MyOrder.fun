import { describe, expect, it } from "vitest";
import { CATALOG_LIFECYCLE_LABEL } from "../catalogLifecycleStatus";

describe("admin catalogue lifecycle status", () => {
  it("has distinct restrictive labels for server-derived lifecycle states", () => {
    expect(CATALOG_LIFECYCLE_LABEL.customer_visible).toBe("Customer Visible");
    expect(CATALOG_LIFECYCLE_LABEL.unavailable_hidden).toBe("Unavailable / Hidden");
    expect(CATALOG_LIFECYCLE_LABEL.compliance_hold).toBe("Compliance Hold");
    expect(CATALOG_LIFECYCLE_LABEL.archived).toBe("Archived");
  });
});
