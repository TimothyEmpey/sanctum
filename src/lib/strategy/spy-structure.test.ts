import { describe, expect, it } from "vitest";
import { etInstant } from "@/lib/market/time";
import { evaluateSpyStructure, spyWatchOpen } from "@/lib/strategy/spy-structure";
import type { Bar } from "@/lib/strategy/intraday-momentum";

const DATE = "2026-10-14";

function bar(hour: number, minute: number, close: number, low = close, high = close): Bar {
  return { ts: etInstant(DATE, hour, minute).getTime(), open: close, high, low, close, volume: 1 };
}

function reversal(): Bar[] {
  return [
    bar(9, 30, 105, 102, 108),
    bar(9, 45, 101, 100, 110),
    bar(10, 0, 106, 103, 107),
    bar(10, 15, 100, 99, 109),
    bar(10, 30, 111, 101, 112),
  ];
}

const levels = { priorHigh: 120, priorLow: 90, hasOpenPosition: false, tradesTaken: 0 };

describe("SPY price action", () => {
  it("waits until the cash open", () => {
    const view = evaluateSpyStructure({ ...levels, now: etInstant(DATE, 9, 20), bars: [] });
    expect(view.state).toBe("waiting");
    expect(view.proposal).toBeNull();
    expect(spyWatchOpen(etInstant(DATE, 9, 20))).toBe(false);
    expect(spyWatchOpen(etInstant(DATE, 10, 46))).toBe(true);
  });

  it("does not buy the sweep candle", () => {
    const view = evaluateSpyStructure({ ...levels, now: etInstant(DATE, 10, 31), bars: reversal() });
    expect(view.state).toBe("waiting");
    expect(view.proposal).toBeNull();
  });

  it("buys the 15-minute close back above the high", () => {
    const view = evaluateSpyStructure({ ...levels, now: etInstant(DATE, 10, 46), bars: reversal() });
    expect(view.state).toBe("ready");
    expect(view.proposal?.side).toBe("LONG");
    expect(view.proposal?.entryPrice).toBe(111);
    expect(view.proposal?.stopPrice).toBe(99);
    expect(view.proposal?.targetPrice).toBe(120);
    expect(view.proposal?.setup).toBe("SPY_STRUCTURE");
  });

  it("uses one times the risk when no high is drawn above the entry", () => {
    const view = evaluateSpyStructure({
      ...levels,
      priorHigh: null,
      now: etInstant(DATE, 10, 46),
      bars: reversal(),
    });
    expect(view.proposal?.entryPrice).toBe(111);
    expect(view.proposal?.stopPrice).toBe(99);
    expect(view.proposal?.targetPrice).toBe(123);
  });

  it("keeps the latest long after an earlier one expires", () => {
    const bars = [
      ...reversal(),
      bar(10, 45, 107, 105, 108),
      bar(10, 50, 110, 100, 112),
      bar(10, 55, 106, 104, 109),
      bar(11, 0, 99, 98, 105),
      bar(11, 5, 113, 101, 114),
    ];
    const missed = evaluateSpyStructure({ ...levels, now: etInstant(DATE, 11, 0), bars: reversal() });
    expect(missed.state).toBe("passed");
    expect(missed.ready).toBe(false);
    expect(missed.proposal?.entryPrice).toBe(111);
    const next = evaluateSpyStructure({ ...levels, now: etInstant(DATE, 11, 11), bars });
    expect(next.state).toBe("ready");
    expect(next.proposal?.entryPrice).toBe(113);
    expect(next.proposal?.stopPrice).toBe(98);
    expect(next.proposal?.signalBarTs).toBeGreaterThan(missed.proposal?.signalBarTs ?? 0);
  });

  it("does not buy a 5-minute dip that breaks the 15-minute low", () => {
    const bars = [
      ...reversal(),
      bar(10, 45, 107, 105, 108),
      bar(10, 50, 110, 100, 112),
      bar(10, 55, 106, 104, 109),
      bar(11, 0, 97, 96, 105),
      bar(11, 5, 113, 101, 114),
    ];
    const view = evaluateSpyStructure({ ...levels, now: etInstant(DATE, 11, 11), bars });
    expect(view.proposal?.entryPrice).not.toBe(113);
  });

  it("does not short a sweep of the highs", () => {
    const bars = [
      bar(9, 30, 99, 98, 100),
      bar(9, 45, 103, 99, 104),
      bar(10, 0, 101, 97, 102),
      bar(10, 15, 102, 100, 108),
      bar(10, 30, 96, 96, 103),
    ];
    const open = evaluateSpyStructure({ ...levels, now: etInstant(DATE, 11, 0), bars });
    expect(open.state).toBe("waiting");
    expect(open.proposal).toBeNull();
    expect(open.standDown).toBeNull();
    const closed = evaluateSpyStructure({ ...levels, now: etInstant(DATE, 16, 0), bars });
    expect(closed.proposal).toBeNull();
    expect(closed.state).toBe("flat");
    expect(closed.standDown).toMatch(/does not short/);
  });

  it("says the bars are missing instead of calling the day flat", () => {
    const view = evaluateSpyStructure({ ...levels, now: etInstant(DATE, 11, 0), bars: [] });
    expect(view.state).toBe("missing");
    expect(view.proposal).toBeNull();
  });
});
