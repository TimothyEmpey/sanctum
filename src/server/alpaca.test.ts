import { describe, expect, it } from "vitest";
import { assertPaperBaseUrl, paperBracketOrder, paperCryptoLimitBuy, paperCryptoStop } from "@/server/alpaca";

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

  it("builds a QQQ bracket and a crypto limit without a take-profit", () => {
    expect(
      paperBracketOrder({
        symbol: "QQQ",
        quantity: 1,
        limitPrice: 500,
        stopPrice: 490,
        targetPrice: 525,
        clientOrderId: "uriel-qqq",
      }).symbol,
    ).toBe("QQQ");
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
});
