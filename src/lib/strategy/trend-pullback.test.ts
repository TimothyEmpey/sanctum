import { describe, expect, it } from "vitest";
import { etInstant } from "@/lib/market/time";
import { evaluateTrendPullback, type Bar } from "@/lib/strategy/trend-pullback";

const DATE = "2026-10-02";

function bar(minuteOfDay: number, open: number, high: number, low: number, close: number, volume = 1_000): Bar {
  return {
    ts: etInstant(DATE, Math.floor(minuteOfDay / 60), minuteOfDay % 60).getTime(),
    open,
    high,
    low,
    close,
    volume,
  };
}

function climb(): Bar[] {
  const bars: Bar[] = [];
  for (let offset = 0; offset < 25; offset += 1) {
    const price = 100 + offset * 0.02;
    bars.push(bar(9 * 60 + 30 + offset, price, price, price, price));
  }
  return bars;
}

function pullback(startMinute: number, open: number, low: number, close: number, volume = 800): Bar[] {
  return [
    bar(startMinute, open, open + 0.05, low, open + 0.02, volume),
    bar(startMinute + 1, open + 0.02, open + 0.08, low + 0.05, open + 0.04, volume),
    bar(startMinute + 2, open + 0.04, open + 0.1, low + 0.08, open + 0.06, volume),
    bar(startMinute + 3, open + 0.06, close, low + 0.1, close - 0.04, volume),
    bar(startMinute + 4, close - 0.04, close + 0.05, close - 0.02, close, volume),
  ];
}

function at(hour: number, minute: number, bars: Bar[], overrides: Partial<Parameters<typeof evaluateTrendPullback>[0]> = {}) {
  return evaluateTrendPullback({
    now: etInstant(DATE, hour, minute),
    bars,
    hasOpenPosition: false,
    tradesTaken: 0,
    consecutiveLosses: 0,
    ...overrides,
  });
}

describe("SPY trend pullback", () => {
  it("buys a dip and places the stop at least 0.25% under the entry", () => {
    const decision = at(10, 0, [...climb(), ...pullback(9 * 60 + 55, 100.4, 100.2, 100.55)]);
    const proposal = decision.proposal;
    expect(proposal?.side).toBe("LONG");
    expect(proposal?.setup).toBe("TREND_PULLBACK");
    expect(proposal?.strategy).toBe("spy-trend-pullback-2026");
    expect(proposal!.stopPrice).toBeLessThanOrEqual(proposal!.entryPrice * 0.9975);
    const risk = proposal!.entryPrice - proposal!.stopPrice;
    expect(proposal!.targetPrice).toBeCloseTo(proposal!.entryPrice + risk * 1.5, 2);
    expect(proposal?.signalBarTs).toBe(etInstant(DATE, 9, 59).getTime());
  });

  it("keeps a wide dip instead of rejecting it", () => {
    const bars = [
      ...climb(),
      bar(9 * 60 + 55, 100.5, 100.55, 98.4, 100.5, 50),
      bar(9 * 60 + 56, 100.5, 100.7, 100.45, 100.65, 2_000),
      bar(9 * 60 + 57, 100.65, 100.85, 100.6, 100.8, 2_000),
      bar(9 * 60 + 58, 100.8, 100.95, 100.75, 100.9, 2_000),
      bar(9 * 60 + 59, 100.9, 101.05, 100.85, 101, 2_000),
    ];
    const decision = at(10, 0, bars);
    const proposal = decision.proposal;
    expect(proposal).not.toBeNull();
    expect(proposal!.stopPrice).toBeLessThanOrEqual(98.39);
    const risk = proposal!.entryPrice - proposal!.stopPrice;
    expect(proposal!.targetPrice).toBeCloseTo(proposal!.entryPrice + risk * 1.5, 2);
  });

  it("does not take a second trade the same day", () => {
    const decision = at(10, 0, [...climb(), ...pullback(9 * 60 + 55, 100.4, 100.2, 100.55)], { tradesTaken: 1 });
    expect(decision.proposal).toBeNull();
    expect(decision.note).toMatch(/cap/i);
  });

  it("stands down when VWAP is not rising", () => {
    const bars: Bar[] = [];
    for (let offset = 0; offset < 30; offset += 1) {
      bars.push(bar(9 * 60 + 30 + offset, 100, 100.05, 99.95, 100));
    }
    expect(at(10, 0, bars).note).toMatch(/not rising/i);
  });

  it("skips a bar that does not dip and close back up", () => {
    const bars = [...climb(), ...pullback(9 * 60 + 55, 100.5, 100.46, 100.3)];
    expect(at(10, 0, bars).proposal).toBeNull();
  });

  it("does not add while a position is open", () => {
    const decision = at(10, 0, [...climb(), ...pullback(9 * 60 + 55, 100.4, 100.2, 100.55)], { hasOpenPosition: true });
    expect(decision.proposal).toBeNull();
    expect(decision.note).toMatch(/already open/i);
  });
});
