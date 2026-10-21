import { describe, expect, it } from "vitest";
import { engineClosed, sampleClosed, splitPnl, summarizeRealized, type SplitTrade } from "@/lib/portfolio/pnl";

const trades = [
  { origin: "DEMO", status: "CLOSED", realizedPnlCents: 4_860, rMultiple: 1, closedAt: "2026-09-08", openedAt: "2026-09-08" },
  { origin: "DEMO", status: "CLOSED", realizedPnlCents: -2_400, rMultiple: -1, closedAt: "2026-09-10", openedAt: "2026-09-10" },
  { origin: "ENGINE", status: "CLOSED", realizedPnlCents: 17_280, rMultiple: 1.5, closedAt: "2026-10-07", openedAt: "2026-10-07" },
  { origin: "ENGINE", status: "OPEN", realizedPnlCents: 0, rMultiple: null, closedAt: null, openedAt: "2026-10-07" },
];

describe("realized book", () => {
  it("keeps sample prints out of the realized total", () => {
    const engine = engineClosed(trades);
    expect(engine).toHaveLength(1);
    expect(sampleClosed(trades)).toHaveLength(2);
    expect(summarizeRealized(engine).realized).toBe(17_280);
    expect(summarizeRealized(trades.filter((trade) => trade.status === "CLOSED")).realized).toBe(19_740);
  });
});

function leg(partial: Partial<SplitTrade> & Pick<SplitTrade, "assetClass" | "status">): SplitTrade {
  return {
    origin: "ENGINE",
    side: "LONG",
    quantity: 1,
    entryPrice: 100,
    exitPrice: null,
    realizedPnlCents: 0,
    openedAtMs: 2_000,
    closedAtMs: null,
    mark: null,
    markAtStart: null,
    ...partial,
  };
}

describe("split book P&L", () => {
  it("keeps a stock close and a crypto close on their own books", () => {
    const split = splitPnl(
      [
        leg({ assetClass: "stocks", status: "CLOSED", openedAtMs: 1_500, closedAtMs: 1_800, realizedPnlCents: 500, exitPrice: 105 }),
        leg({ assetClass: "crypto", status: "CLOSED", quantity: 0.01, entryPrice: 100, exitPrice: 110, realizedPnlCents: 10, openedAtMs: 1_100, closedAtMs: 1_400 }),
        leg({ assetClass: "stocks", status: "CLOSED", origin: "DEMO", realizedPnlCents: 9_999, closedAtMs: 1_600, exitPrice: 200 }),
      ],
      1_000,
    );
    expect(split).toEqual({ stocks: 500, crypto: 10 });
  });

  it("counts an overnight position only from the mark at the window", () => {
    const split = splitPnl(
      [
        leg({
          assetClass: "crypto",
          status: "OPEN",
          quantity: 0.01,
          entryPrice: 100,
          openedAtMs: 500,
          mark: 130,
          markAtStart: 120,
        }),
      ],
      1_000,
    );
    expect(split.crypto).toBe(10);
    expect(split.stocks).toBe(0);
  });
});
