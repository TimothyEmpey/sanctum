import { describe, expect, it } from "vitest";
import { etInstant } from "@/lib/market/time";
import type { Bar } from "@/lib/strategy/intraday-momentum";
import { evaluateQqqMomentum } from "@/lib/strategy/qqq-momentum";

function bar(date: string, hour: number, minute: number, close: number, open = close): Bar {
  return {
    ts: etInstant(date, hour, minute).getTime(),
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1_000,
  };
}

describe("QQQ last half-hour", () => {
  it("uses the QQQ strategy id on the same clock as SPY", () => {
    const view = evaluateQqqMomentum({
      now: etInstant("2026-10-02", 15, 30),
      bars: [bar("2026-10-02", 9, 59, 101), bar("2026-10-02", 15, 29, 101.4)],
      priorClose: 100,
      earlyClose: false,
      hasOpenPosition: false,
      tradesTaken: 0,
    });
    expect(view.proposal?.symbol).toBe("QQQ");
    expect(view.proposal?.strategy).toBe("qqq-intraday-momentum-2018");
    expect(view.proposal?.side).toBe("LONG");
  });
});
