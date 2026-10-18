import { describe, expect, it } from "vitest";
import { fallbackTarget, fractionalExitChoice, matchingTarget } from "@/lib/broker/fractional-exit";
import { assertPaperBaseUrl, paperBracketOrder, paperCryptoLimitBuy, paperCryptoStop, paperStockLimitBuy, paperStockStop } from "@/server/alpaca";

describe("alpaca paper broker", () => {
  it("locks orders to the paper host", () => {
    expect(assertPaperBaseUrl("https://paper-api.alpaca.markets/v2")).toBe("https://paper-api.alpaca.markets");
    expect(() => assertPaperBaseUrl("https://api.alpaca.markets")).toThrow(/paper host/);
  });

  it("builds a SPY bracket with a stop and a target", () => {
    expect(
      paperBracketOrder({
        symbol: "SPY",
        quantity: 4,
        limitPrice: 500.12,
        stopPrice: 497.5,
        targetPrice: 504.05,
        clientOrderId: "uriel-1",
      }),
    ).toMatchObject({
      symbol: "SPY",
      qty: "4",
      side: "buy",
      type: "limit",
      order_class: "bracket",
      limit_price: "500.12",
      stop_loss: { stop_price: "497.50" },
      take_profit: { limit_price: "504.05" },
    });
    expect(() =>
      paperBracketOrder({
        symbol: "AAPL",
        quantity: 1,
        limitPrice: 10,
        stopPrice: 9,
        targetPrice: 12,
        clientOrderId: "uriel-2",
      }),
    ).toThrow(/untouchable/);
    expect(() =>
      paperBracketOrder({
        symbol: "SPY",
        quantity: 1,
        limitPrice: 10,
        stopPrice: 10,
        targetPrice: 12,
        clientOrderId: "uriel-3",
      }),
    ).toThrow(/stop/);
  });

  it("builds a crypto limit without a take-profit and keeps NQ off Alpaca", () => {
    expect(() =>
      paperBracketOrder({
        symbol: "NQ",
        quantity: 1,
        limitPrice: 500,
        stopPrice: 490,
        targetPrice: 525,
        clientOrderId: "uriel-nq",
      }),
    ).toThrow(/Nasdaq/);
    expect(
      paperCryptoLimitBuy({ symbol: "BTC/USD", quantity: 0.01, limitPrice: 100_000, clientOrderId: "fonzo-btc" }),
    ).toMatchObject({
      symbol: "BTC/USD",
      qty: "0.01",
      side: "buy",
      type: "limit",
      time_in_force: "gtc",
    });
    const stop = paperCryptoStop({ symbol: "ETH/USD", quantity: 0.25, stopPrice: 4_000, clientOrderId: "fonzo-eth" });
    expect(stop.type).toBe("stop_limit");
    expect(stop.side).toBe("sell");
    expect(Number(stop.limit_price)).toBeLessThan(Number(stop.stop_price));
    expect(() => paperCryptoLimitBuy({ symbol: "SPY", quantity: 1, limitPrice: 10, clientOrderId: "nope" })).toThrow(/untouchable/);
  });

  it("sends a fractional SPY buy as a simple day order and a separate stop", () => {
    const buy = paperStockLimitBuy({
      symbol: "SPY",
      quantity: 0.324,
      limitPrice: 770,
      stopPrice: 768,
      targetPrice: 774,
      clientOrderId: "uriel-spy-fraction",
    });
    expect(buy).toMatchObject({ symbol: "SPY", qty: "0.324", side: "buy", type: "limit", time_in_force: "day" });
    expect(buy).not.toHaveProperty("order_class");
    expect(buy).not.toHaveProperty("take_profit");
    expect(buy).not.toHaveProperty("stop_loss");
    expect(() =>
      paperBracketOrder({
        symbol: "SPY",
        quantity: 0.324,
        limitPrice: 770,
        stopPrice: 768,
        targetPrice: 774,
        clientOrderId: "uriel-spy-fraction",
      }),
    ).toThrow(/bracket/);
    const stop = paperStockStop({ symbol: "SPY", quantity: 0.324, stopPrice: 768, clientOrderId: "spy-stop-1" });
    expect(stop).toMatchObject({ symbol: "SPY", qty: "0.324", side: "sell", type: "stop", time_in_force: "day", stop_price: "768.00" });
    expect(stop).not.toHaveProperty("order_class");
    expect(() => paperStockLimitBuy({ symbol: "NQ", quantity: 0.008, limitPrice: 30_000, stopPrice: 29_900, targetPrice: 30_200, clientOrderId: "nq" })).toThrow(/Nasdaq/);
    expect(() => paperStockStop({ symbol: "NQ", quantity: 0.008, stopPrice: 29_900, clientOrderId: "nq-stop" })).toThrow(/Nasdaq/);
  });

  it("lets the broker stop win when the same bar also trades the target", () => {
    const opened = Date.parse("2026-10-16T14:30:00.000Z");
    expect(
      fractionalExitChoice({
        openedAt: opened,
        stop: 760,
        target: 764,
        bars: [{ ts: opened, high: 764.2, low: 759.5 }],
      }),
    ).toBe("stop");
    expect(
      fractionalExitChoice({
        openedAt: opened,
        stop: 760,
        target: 764,
        bars: [{ ts: opened - 60_000, high: 770, low: 750 }, { ts: opened + 60_000, high: 764.1, low: 762 }],
      }),
    ).toBe("target");
    expect(fractionalExitChoice({ openedAt: opened, stop: 760, target: 764, bars: [{ ts: opened, high: 763, low: 761 }] })).toBe("hold");
    expect(matchingTarget({ symbol: "SPY", entryPrice: 762.97, stopPrice: 760.64, targetPrice: 765.1 }, { symbol: "SPY", limitPrice: 762.97, stopPrice: 760.64 }, 762.5)).toBe(765.1);
    expect(matchingTarget({ symbol: "SPY", entryPrice: 100, stopPrice: 99, targetPrice: 101 }, { symbol: "SPY", limitPrice: 762.97, stopPrice: 760.64 }, 762.5)).toBeNull();
    expect(fallbackTarget(762.5, 760.64)).toBe(764.36);
  });
});
