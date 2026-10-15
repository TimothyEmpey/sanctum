import { describe, expect, it } from "vitest";
import { etInstant } from "@/lib/market/time";
import { evaluateNqSweep, type NqSnapshot } from "@/lib/strategy/nq-sweep";
import type { Bar } from "@/lib/strategy/intraday-momentum";

function bar(hour: number, minute: number, close: number, low = close, high = close): Bar {
  return { ts: etInstant("2026-10-14", hour, minute).getTime(), open: close, high, low, close, volume: 1 };
}

function esUp(): Bar[] {
  return [bar(9, 30, 10, 9, 10), bar(9, 35, 12, 10, 12), bar(9, 40, 11, 10, 11), bar(9, 45, 13, 11, 14)];
}

function nasdaqLong(): Bar[] {
  const bars: Bar[] = [
    bar(9, 30, 100, 99, 102),
    bar(9, 31, 100),
    bar(9, 32, 100),
    bar(9, 33, 100),
    bar(9, 34, 100),
    bar(9, 35, 102, 100, 103),
    bar(9, 40, 99, 98, 101),
    bar(9, 45, 105, 102, 106),
    bar(9, 50, 105),
    bar(9, 51, 104),
    bar(9, 52, 103),
    bar(9, 53, 104),
    bar(9, 54, 106),
    bar(9, 55, 104),
    bar(9, 56, 102),
    bar(9, 57, 104),
    bar(9, 58, 107),
    bar(9, 59, 105),
    bar(10, 0, 106),
    bar(10, 1, 108),
  ];
  return bars;
}

const base = {
  priorHigh: 120,
  priorLow: 100,
  hasOpenPosition: false,
  tradesTaken: 0,
};

describe("NQ liquidity sweep", () => {
  it("waits until the cash open", () => {
    const view = evaluateNqSweep({
      ...base,
      now: etInstant("2026-10-14", 9, 20),
      bars: [],
      esBars: [],
    });
    expect(view.state).toBe("waiting");
    expect(view.proposal).toBeNull();
  });

  it("buys the long continuation when Nasdaq and S&P futures both break up", () => {
    const view = evaluateNqSweep({
      ...base,
      now: etInstant("2026-10-14", 10, 2),
      bars: nasdaqLong(),
      esBars: esUp(),
    });
    expect(view.state).toBe("ready");
    expect(view.proposal?.symbol).toBe("NQ");
    expect(view.proposal?.side).toBe("LONG");
    expect(view.proposal?.entryPrice).toBe(108);
    expect(view.proposal?.stopPrice).toBeLessThan(108);
    expect(view.proposal?.targetPrice).toBeGreaterThan(108);
  });

  it("stays flat when the S&P futures do not break up", () => {
    const view = evaluateNqSweep({
      ...base,
      now: etInstant("2026-10-14", 10, 25),
      bars: nasdaqLong(),
      esBars: [bar(9, 30, 10, 9, 10), bar(9, 35, 8, 8, 9), bar(9, 40, 9, 8, 9), bar(9, 45, 7, 7, 8)],
    });
    expect(view.proposal).toBeNull();
    expect(view.state).toBe("flat");
    expect(view.standDown).toMatch(/not align/);
  });

  it("does not short a sweep of the prior high", () => {
    const bars = [bar(9, 30, 121, 119, 122), bar(9, 35, 118, 117, 120), bar(9, 40, 119, 118, 119), bar(9, 45, 116, 115, 118)];
    const view: NqSnapshot = evaluateNqSweep({
      ...base,
      now: etInstant("2026-10-14", 10, 25),
      bars,
      esBars: esUp(),
    });
    expect(view.proposal).toBeNull();
    expect(view.standDown).toMatch(/does not short/);
  });
});
