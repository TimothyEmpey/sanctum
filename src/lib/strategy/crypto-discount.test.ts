import { describe, expect, it } from "vitest";
import { aggregateHours, evaluateCryptoDiscount, type CryptoProposal } from "@/lib/strategy/crypto-discount";
import type { Bar } from "@/lib/strategy/intraday-momentum";

const START = Date.parse("2026-01-01T00:00:00.000Z");

function hour(index: number, high: number, low: number, close: number): Bar {
  return { ts: START + index * 60 * 60 * 1000, open: close, high, low, close, volume: 1 };
}

function view(bars: Bar[], nowIndex: number, extra?: { symbol?: "BTC/USD" | "ETH/USD"; open?: boolean; taken?: number }) {
  return evaluateCryptoDiscount({
    now: new Date(START + nowIndex * 60 * 60 * 1000),
    bars,
    symbol: extra?.symbol ?? "BTC/USD",
    strategy: extra?.symbol === "ETH/USD" ? "eth-discount-range" : "btc-discount-range",
    hasOpenPosition: extra?.open ?? false,
    tradesTaken: extra?.taken ?? 0,
  });
}

/** Nine completed hours. Higher frames have no swing, so this is the one-hour book. */
function discountHours(lastLow = 106, lastClose = 112) {
  return [
    hour(0, 112, 110, 111),
    hour(1, 111, 108, 109),
    hour(2, 105, 100, 104),
    hour(3, 114, 106, 113),
    hour(4, 125, 118, 124),
    hour(5, 122, 116, 120),
    hour(6, 132, 128, 131),
    hour(7, 129, 121, 124),
    hour(8, 115, lastLow, lastClose),
  ];
}

describe("crypto discount range", () => {
  it("buys the bottom quarter after a break and a return, on BTC and ETH", () => {
    const btc = view(discountHours(), 9);
    const proposal = btc.proposal as CryptoProposal | null;
    expect(btc.frameHours).toBe(1);
    expect(btc.state).toBe("ready");
    expect(proposal?.symbol).toBe("BTC/USD");
    expect(proposal?.setup).toBe("CRYPTO_DISCOUNT");
    expect(proposal?.side).toBe("LONG");
    expect(proposal?.entryPrice).toBe(108);
    expect(proposal?.stopPrice).toBe(100);
    expect(proposal?.targetPrice).toBe(132);
    expect(proposal!.stopPrice).toBeLessThan(proposal!.entryPrice);
    expect(proposal!.targetPrice).toBeGreaterThan(proposal!.entryPrice);

    const eth = view(discountHours(), 9, { symbol: "ETH/USD" });
    expect(eth.proposal?.symbol).toBe("ETH/USD");
    expect(eth.proposal?.strategy).toBe("eth-discount-range");
    expect(eth.proposal?.entryPrice).toBe(108);
    expect(eth.proposal?.stopPrice).toBe(100);
  });

  it("does not buy above the discount", () => {
    const above = view(discountHours(110, 112), 9);
    expect(above.proposal).toBeNull();
    expect(above.state).toBe("waiting");
  });

  it("does not buy when price trades through the swing low", () => {
    const broken = view(discountHours(99, 101), 9);
    expect(broken.proposal).toBeNull();
    expect(broken.state).not.toBe("ready");
  });

  it("stands down a premium short and does not open one", () => {
    const bars = [
      hour(0, 120, 118, 119),
      hour(1, 125, 121, 124),
      hour(2, 130, 126, 129),
      hour(3, 124, 115, 116),
      hour(4, 112, 100, 102),
      hour(5, 108, 101, 104),
      hour(6, 101, 96, 97),
      hour(7, 118, 108, 116),
      hour(8, 128, 119, 127),
    ];
    const result = view(bars, 9);
    expect(result.proposal).toBeNull();
    expect(result.standDown).toMatch(/short setup is off/);
  });

  it("keeps the eight-hour chart when that chart has a swing and price is not in discount", () => {
    const templates = [
      [112, 110, 111],
      [111, 108, 109],
      [105, 100, 104],
      [114, 106, 113],
      [125, 118, 124],
      [122, 116, 120],
      [132, 128, 131],
    ];
    const bars = templates.flatMap(([high, low, close], bucket) =>
      Array.from({ length: 8 }, (_, hourIndex) => hour(bucket * 8 + hourIndex, high, low, close)),
    );
    const result = view(bars, 56);
    expect(result.frameHours).toBe(8);
    expect(result.proposal).toBeNull();
    expect(result.state).toBe("waiting");
  });

  it("stays missing without prices and flat once the session already has an entry", () => {
    expect(view([], 9).state).toBe("missing");
    expect(view(discountHours(), 9, { open: true }).proposal).toBeNull();
    expect(view(discountHours(), 9, { taken: 1 }).state).toBe("flat");
  });

  it("buckets eight-hour bars on UTC boundaries", () => {
    const bars = [hour(0, 2, 1, 2), hour(7, 4, 3, 4), hour(8, 9, 8, 9)];
    const framed = aggregateHours(bars, 8, START + 16 * 60 * 60 * 1000);
    expect(framed).toHaveLength(2);
    expect(framed[0].low).toBe(1);
    expect(framed[0].high).toBe(4);
    expect(framed[1].close).toBe(9);
  });
});
