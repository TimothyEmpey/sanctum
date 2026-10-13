import { describe, expect, it } from "vitest";
import { evaluateCryptoMomentum, type CryptoProposal } from "@/lib/strategy/crypto-momentum";
import type { Bar } from "@/lib/strategy/intraday-momentum";

function bar(iso: string, open: number, close: number): Bar {
  const ts = new Date(iso).getTime();
  return { ts, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1 };
}

const up = [bar("2026-10-02T00:00:00.000Z", 100, 100), bar("2026-10-02T00:29:00.000Z", 101, 101)];

function at(iso: string, bars: Bar[] = up) {
  return evaluateCryptoMomentum({
    now: new Date(iso),
    bars,
    symbol: "BTC/USD",
    strategy: "btc-intraday-momentum-2022",
    hasOpenPosition: false,
    tradesTaken: 0,
  });
}

describe("crypto last half-hour", () => {
  it("buys at 23:30 UTC when the first half-hour is up", () => {
    const view = at("2026-10-02T23:30:00.000Z");
    const proposal = view.proposal as CryptoProposal | null;
    expect(proposal?.symbol).toBe("BTC/USD");
    expect(proposal?.strategy).toBe("btc-intraday-momentum-2022");
    expect(proposal?.market).toBe("crypto");
    expect(proposal?.side).toBe("LONG");
    expect(proposal!.stopPrice).toBeLessThan(proposal!.entryPrice);
  });

  it("stays flat when the first half-hour is not higher", () => {
    const view = at("2026-10-02T23:30:00.000Z", [
      bar("2026-10-02T00:00:00.000Z", 100, 100),
      bar("2026-10-02T00:29:00.000Z", 100, 100),
    ]);
    expect(view.proposal).toBeNull();
    expect(view.standDown).toMatch(/stays flat/);
  });

  it("does not buy at midday or after the entry grace", () => {
    expect(at("2026-10-02T12:00:00.000Z").proposal).toBeNull();
    const late = at("2026-10-02T23:35:00.000Z");
    expect(late.proposal).toBeNull();
    expect(late.standDown).toMatch(/passed/);
  });
});
