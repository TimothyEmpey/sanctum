import { describe, expect, it } from "vitest";
import { layoutCandles } from "@/components/charts";

function points(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    t: Date.UTC(2026, 9, 13, 14, index),
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 1_000 + index,
  }));
}

describe("floor chart fit", () => {
  it("draws a short half-width chart and leaves the desk size alone", () => {
    const bars = points(24);
    expect(layoutCandles(bars, 220, 130, "5m")).toBeNull();
    expect(layoutCandles(bars, 480, 120, "5m")).toBeNull();
    const fitted = layoutCandles(bars, 220, 130, "5m", true);
    expect(fitted).not.toBeNull();
    expect(fitted?.candles).toHaveLength(24);
    expect(fitted?.height).toBe(130);
  });
});
