import { describe, expect, it } from "vitest";
import { nextUberDeliveryStatus } from "../uberDeliveryState";

describe("Uber delivery state authority", () => {
  it("accepts forward progress and terminal delivery", () => {
    expect(nextUberDeliveryStatus(null, "pending")).toBe("pending");
    expect(nextUberDeliveryStatus("pending", "pickup")).toBe("pickup");
    expect(nextUberDeliveryStatus("pickup", "dropoff")).toBe("dropoff");
    expect(nextUberDeliveryStatus("dropoff", "delivered")).toBe("delivered");
  });

  it("rejects replay, regression, unknown state, and reversal after a terminal result", () => {
    expect(nextUberDeliveryStatus("pickup", "pickup")).toBeNull();
    expect(nextUberDeliveryStatus("dropoff", "pending")).toBeNull();
    expect(nextUberDeliveryStatus("dropoff", "fabricated")).toBeNull();
    expect(nextUberDeliveryStatus("delivered", "canceled")).toBeNull();
    expect(nextUberDeliveryStatus("returned", "delivered")).toBeNull();
    expect(nextUberDeliveryStatus("pickup", "returned")).toBe("returned");
  });
});
