import { describe, expect, it } from "vitest";
import { availableFromBalanceError, sellableQty } from "@/lib/broker/crypto-qty";

describe("crypto sell quantity", () => {
  it("sells the available balance when a fee leaves less than the order", () => {
    expect(sellableQty(0.003, 0.002992498)).toBe(0.00299249);
    expect(sellableQty(0.003, 0.002992498)).toBeLessThan(0.002992498);
    expect(sellableQty(0.003, null)).toBe(0.003);
    expect(sellableQty(0.003, 0)).toBe(0);
  });

  it("reads the available amount from the broker rejection", () => {
    expect(availableFromBalanceError("insufficient balance for BTC (requested: 0.003, available: 0.002992498)")).toBe(
      0.002992498,
    );
    expect(availableFromBalanceError("rejected")).toBeNull();
  });
});
