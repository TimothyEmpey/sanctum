import { ASSETS, assetLabel, type Asset } from "@/lib/assets";
import { alpacaPaperConfigured } from "@/server/alpaca";
import { prisma } from "@/server/db";
import { alignAlpaca } from "@/server/trading";

/** Grid order on the floor. The single-asset desk is unchanged. */
const FLOOR_SYMBOLS = ["BTC/USD", "ETH/USD", "SPY", "QQQ"] as const;

function candle(bar: { ts: Date; open: number; high: number; low: number; close: number; volume: number }) {
  return {
    t: bar.ts.getTime(),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  };
}

async function barsFor(accountId: string, symbol: string) {
  const [dailyBars, minuteBars, latestBar] = await Promise.all([
    prisma.marketBar.findMany({
      where: { accountId, symbol, timeframe: "1d" },
      orderBy: { ts: "desc" },
      take: 140,
    }),
    prisma.marketBar.findMany({
      where: { accountId, symbol, timeframe: "1m" },
      orderBy: { ts: "desc" },
      take: 500,
    }),
    prisma.marketBar.findFirst({
      where: { accountId, symbol },
      orderBy: { ts: "desc" },
    }),
  ]);
  return {
    mark: latestBar?.close ?? null,
    daily: dailyBars.map(candle).reverse(),
    minute: minuteBars.map(candle).reverse(),
  };
}

export async function getFloor() {
  const now = new Date();
  const existing = await prisma.account.findFirst({ select: { id: true } });
  if (!existing) return null;
  if (alpacaPaperConfigured()) {
    try {
      await alignAlpaca(existing.id, now);
    } catch {
      // The floor still renders from the stored book.
    }
  }
  const account = await prisma.account.findFirst({
    include: {
      holdings: { orderBy: { symbol: "asc" } },
      trades: { where: { status: "OPEN", origin: "ENGINE" }, orderBy: { openedAt: "desc" } },
    },
  });
  if (!account) return null;

  const panels = await Promise.all(
    FLOOR_SYMBOLS.map(async (symbol) => {
      const asset = ASSETS.find((item) => item.symbol === symbol) as Asset;
      const bars = await barsFor(account.id, symbol);
      const mark = bars.mark;
      return {
        symbol,
        label: assetLabel(asset),
        workerName: asset.desk === "fonzo" ? "Fonzo" : "Uriel",
        mark,
        bars: { daily: bars.daily, minute: bars.minute },
        openTrades: account.trades
          .filter((trade) => trade.symbol === symbol)
          .map((trade) => ({
            id: trade.id,
            symbol: trade.symbol,
            side: trade.side,
            quantity: trade.quantity,
            entryPrice: trade.entryPrice,
            stopPrice: trade.stopPrice,
            targetPrice: trade.targetPrice,
            setup: trade.setup,
            origin: trade.origin,
            unrealizedCents: Math.round(
              ((mark ?? trade.entryPrice) - trade.entryPrice) * trade.quantity * (trade.side === "LONG" ? 1 : -1) * 100,
            ),
          })),
        baseline: account.holdings
          .filter((holding) => holding.symbol === symbol && holding.origin === "BASELINE")
          .map((holding) => {
            const price = mark ?? holding.marketPrice;
            return {
              symbol: holding.symbol,
              quantity: holding.quantity,
              averagePrice: holding.averagePrice,
              marketPrice: price,
              marketValueCents: Math.round(holding.quantity * price * 100),
            };
          }),
      };
    }),
  );

  return {
    urielPaused: account.agentPaused,
    fonzoPaused: account.fonzoPaused,
    halted: Boolean(account.haltReason),
    panels,
  };
}

export type Floor = NonNullable<Awaited<ReturnType<typeof getFloor>>>;
