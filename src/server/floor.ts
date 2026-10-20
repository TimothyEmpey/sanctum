import { ASSETS, assetLabel, type Asset } from "@/lib/assets";
import { sessionClock } from "@/lib/market/calendar";
import { cryptoSessionClock } from "@/lib/market/crypto-clock";
import { alpacaPaperConfigured } from "@/server/alpaca";
import { prisma } from "@/server/db";
import { alignAlpaca, readFonzoHeartbeat, readHeartbeat } from "@/server/trading";
import { assetTriggerCaveat, loadDayMinutes, loadSignalMinutes, loadStructureHours, loadStructureMinutes } from "@/server/trigger-note";

/** Floor grid: SPY, BTC, then NQ, ETH. The single-asset desk is unchanged. */
const FLOOR_SYMBOLS = ["SPY", "BTC/USD", "NQ", "ETH/USD"] as const;

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
  const stockClock = sessionClock(now);
  const cryptoClock = cryptoSessionClock(now);
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
      orders: { where: { status: "WORKING", purpose: "ENTRY" }, select: { symbol: true } },
      sessions: {
        where: { sessionDate: { in: [stockClock.dateKey, cryptoClock.dateKey] } },
        select: { symbol: true, sessionDate: true, tradesTaken: true },
      },
      decisions: {
        orderBy: { createdAt: "desc" },
        take: 40,
        select: { approved: true, proposal: true, reasons: true, createdAt: true },
      },
    },
  });
  if (!account) return null;
  const stockBeat = readHeartbeat();
  const fonzoBeat = readFonzoHeartbeat();
  const esMinutes = await loadDayMinutes(account.id, "ES", stockClock.dateKey);

  const panels = await Promise.all(
    FLOOR_SYMBOLS.map(async (symbol) => {
      const asset = ASSETS.find((item) => item.symbol === symbol) as Asset;
      const [bars, minutes] = await Promise.all([
        barsFor(account.id, symbol),
        asset.symbol === "NQ"
          ? loadDayMinutes(account.id, "NQ", stockClock.dateKey)
          : asset.symbol === "SPY"
            ? loadStructureMinutes(account.id, "SPY", stockClock.dateKey)
            : asset.market === "crypto"
              ? loadStructureHours(account.id, asset.symbol)
              : loadSignalMinutes(account.id, asset, now),
      ]);
      const mark = bars.mark;
      const dateKey = asset.market === "crypto" ? cryptoClock.dateKey : stockClock.dateKey;
      const session = account.sessions.find((row) => row.symbol === symbol && row.sessionDate === dateKey);
      const traded =
        account.trades.some((trade) => trade.symbol === symbol) ||
        account.orders.some((order) => order.symbol === symbol) ||
        (symbol !== "SPY" && (session?.tradesTaken ?? 0) > 0);
      const heartbeat = asset.desk === "fonzo" ? fonzoBeat : stockBeat;
      const caveat = assetTriggerCaveat({
        asset,
        now,
        minutes,
        esMinutes: asset.symbol === "NQ" ? esMinutes : [],
        daily: bars.daily.map((bar) => ({ ts: bar.t, close: bar.close, high: bar.high, low: bar.low })),
        traded,
        paused: asset.desk === "fonzo" ? account.fonzoPaused : account.agentPaused,
        haltReason: account.haltReason,
        heartbeatAt: heartbeat?.at,
        riskDecisions: account.decisions,
      });
      return {
        symbol,
        label: assetLabel(asset),
        workerName: asset.desk === "fonzo" ? "Fonzo" : "Uriel",
        caveat,
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
