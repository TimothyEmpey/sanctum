import { assetLabel, normalizeSymbol, resolveView, rulesFor, type Asset } from "@/lib/assets";
import { sessionClock } from "@/lib/market/calendar";
import { cryptoSessionClock, utcParts } from "@/lib/market/crypto-clock";
import { RISK_LIMITS } from "@/lib/risk/constants";
import { riskBudgetCents } from "@/lib/risk/sizing";
import { alpacaPaperConfigured, alpacaStatus } from "@/server/alpaca";
import { prisma } from "@/server/db";
import { robinhoodStatus } from "@/server/robinhood";
import { alignAlpaca, readFonzoHeartbeat, readHeartbeat } from "@/server/trading";

export type DeskQuery = { book?: string; asset?: string };

function proposalSymbol(proposal: unknown) {
  if (!proposal || typeof proposal !== "object" || !("symbol" in proposal)) return null;
  const symbol = (proposal as { symbol?: unknown }).symbol;
  return typeof symbol === "string" ? normalizeSymbol(symbol) : null;
}

function eventForAsset(message: string, kind: string, asset: Asset) {
  const text = message.toUpperCase();
  if (text.includes(asset.symbol.toUpperCase()) || text.includes(assetLabel(asset).toUpperCase())) return true;
  if (kind !== "CONTROL") return false;
  return asset.desk === "fonzo" ? message.includes("Fonzo") : message.includes("Uriel");
}

export async function getDesk(query?: DeskQuery) {
  const now = new Date();
  const view = resolveView(query?.book, query?.asset);
  const asset = view.asset;
  const existing = await prisma.account.findFirst({ select: { id: true } });
  if (existing && alpacaPaperConfigured()) {
    try {
      await alignAlpaca(existing.id, now);
    } catch {
      // The page still renders. The broker line shows that the keys are present.
    }
  }
  const account = await prisma.account.findFirst({
    include: {
      holdings: { orderBy: { symbol: "asc" } },
      trades: { orderBy: { openedAt: "desc" }, take: 200 },
      orders: { orderBy: { createdAt: "desc" }, take: 200 },
      snapshots: { orderBy: { capturedAt: "desc" }, take: 1500 },
      events: { orderBy: { createdAt: "desc" }, take: 80 },
      decisions: { orderBy: { createdAt: "desc" }, take: 40 },
      sessions: { orderBy: { sessionDate: "desc" }, take: 30 },
    },
  });
  if (!account) return null;

  const stockClock = sessionClock(now);
  const cryptoClock = cryptoSessionClock(now);
  const viewed = asset.market === "crypto" ? cryptoClock : stockClock;
  const sessionDate = asset.market === "crypto" ? utcParts(now).dateKey : stockClock.dateKey;
  const stockBeat = readHeartbeat();
  const fonzoBeat = readFonzoHeartbeat();
  const heartbeat = asset.market === "crypto" ? fonzoBeat : stockBeat;
  const resetAt = account.bookResetAt;

  const [dailyBars, minuteBars, latestBar] = await Promise.all([
    prisma.marketBar.findMany({
      where: { accountId: account.id, symbol: asset.symbol, timeframe: "1d" },
      orderBy: { ts: "desc" },
      take: 140,
    }),
    prisma.marketBar.findMany({
      where: { accountId: account.id, symbol: asset.symbol, timeframe: "1m" },
      orderBy: { ts: "desc" },
      take: 500,
    }),
    prisma.marketBar.findFirst({
      where: { accountId: account.id, symbol: asset.symbol },
      orderBy: { ts: "desc" },
    }),
  ]);

  const mark = latestBar?.close ?? (asset.symbol === "SPY" ? stockBeat?.spy ?? null : null) ?? null;
  const dayPnlCents = account.equityCents - account.dayStartEquityCents;
  const weekPnlCents = account.equityCents - account.weekStartEquityCents;
  const engineOpen = account.trades.filter((trade) => trade.status === "OPEN" && trade.origin === "ENGINE");
  const openRiskCents = engineOpen.reduce(
    (sum, trade) => sum + Math.round(Math.abs(trade.entryPrice - trade.stopPrice) * trade.quantity * 100),
    0,
  );
  const session = account.sessions.find((row) => row.symbol === asset.symbol && row.sessionDate === sessionDate) ?? null;
  const assetTrades = account.trades.filter((trade) => trade.symbol === asset.symbol);
  const assetOrders = account.orders.filter((order) => order.symbol === asset.symbol);
  const snapshots = account.snapshots.filter((row) => !resetAt || row.capturedAt >= resetAt);

  return {
    demo: account.demo,
    mode: account.mode,
    paused: asset.desk === "fonzo" ? account.fonzoPaused : account.agentPaused,
    urielPaused: account.agentPaused,
    fonzoPaused: account.fonzoPaused,
    haltReason: account.haltReason,
    shortingEnabled: account.shortingEnabled,
    workerName: asset.desk === "fonzo" ? "Fonzo" : "Uriel",
    deskName: asset.desk,
    assetClass: asset.assetClass,
    symbol: asset.symbol,
    assetLabel: assetLabel(asset),
    playbook: asset.playbook,
    rules: rulesFor(asset),
    strategy: asset.strategyName,
    stockLive: stockClock.tradingDay && stockClock.phase !== "closed" && stockClock.phase !== "idle",
    clock: {
      phase: viewed.phase,
      label: viewed.label,
      dateKey: viewed.dateKey,
      tradingDay: asset.market === "crypto" ? true : stockClock.tradingDay,
    },
    spy: mark,
    mark,
    equityCents: account.equityCents,
    cashCents: account.cashCents,
    brokerEquityCents: account.brokerEquityCents,
    brokerCashCents: account.brokerCashCents,
    peakEquityCents: account.peakEquityCents,
    dayPnlCents,
    weekPnlCents,
    dailyLossRemainingCents: riskBudgetCents(account.dayStartEquityCents, RISK_LIMITS.maxDailyLoss) + dayPnlCents,
    weeklyLossRemainingCents: riskBudgetCents(account.weekStartEquityCents, RISK_LIMITS.maxWeeklyLoss) + weekPnlCents,
    drawdown: account.peakEquityCents > 0 ? (account.peakEquityCents - account.equityCents) / account.peakEquityCents : 0,
    openRiskCents,
    openRiskLimitCents: riskBudgetCents(account.equityCents, RISK_LIMITS.maxTotalOpenRisk),
    accountOpenPositions: engineOpen.length,
    tradesToday: session?.tradesTaken ?? 0,
    heartbeat,
    robinhood: robinhoodStatus(),
    alpaca: alpacaStatus(),
    limits: RISK_LIMITS,
    session: session
      ? {
          date: session.sessionDate,
          orHigh: session.orHigh,
          orLow: session.orLow,
          vwap: session.vwap,
          standDown: session.standDown,
          consecutiveLosses: session.consecutiveLosses,
          longStopped: session.longStopped,
        }
      : null,
    holdings: account.holdings.map((holding) => {
      const price = holding.symbol === asset.symbol && mark ? mark : holding.marketPrice;
      return {
        symbol: holding.symbol,
        quantity: holding.quantity,
        averagePrice: holding.averagePrice,
        marketPrice: price,
        origin: holding.origin,
        tradable: holding.tradable,
        marketValueCents: Math.round(holding.quantity * price * 100),
        unrealizedCents: Math.round((price - holding.averagePrice) * holding.quantity * 100),
      };
    }),
    openTrades: engineOpen
      .filter((trade) => trade.symbol === asset.symbol)
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
        openedAt: trade.openedAt.toISOString(),
        unrealizedCents: Math.round(
          ((mark ?? trade.entryPrice) - trade.entryPrice) * trade.quantity * (trade.side === "LONG" ? 1 : -1) * 100,
        ),
      })),
    recentTrades: assetTrades.map((trade) => ({
      id: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      stopPrice: trade.stopPrice,
      targetPrice: trade.targetPrice,
      realizedPnlCents: trade.realizedPnlCents,
      rMultiple: trade.rMultiple,
      status: trade.status,
      setup: trade.setup,
      origin: trade.origin,
      journal: trade.journal,
      priorBook: resetAt != null && trade.openedAt < resetAt,
      openedAt: trade.openedAt.toISOString(),
      closedAt: trade.closedAt?.toISOString() ?? null,
    })),
    orders: assetOrders.map((order) => ({
      id: order.id,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      purpose: order.purpose,
      quantity: order.quantity,
      limitPrice: order.limitPrice,
      stopPrice: order.stopPrice,
      fillPrice: order.fillPrice,
      status: order.status,
      createdAt: order.createdAt.toISOString(),
      filledAt: order.filledAt?.toISOString() ?? null,
      sample: order.brokerOrderId == null,
    })),
    events: account.events
      .filter((event) => eventForAsset(event.message, event.kind, asset))
      .map((event) => ({
        id: event.id,
        level: event.level,
        kind: event.kind,
        message: event.message,
        createdAt: event.createdAt.toISOString(),
      })),
    decisions: account.decisions
      .filter((decision) => {
        const symbol = proposalSymbol(decision.proposal);
        if (symbol == null) return asset.symbol === "SPY";
        return symbol === asset.symbol;
      })
      .slice(0, 12)
      .map((decision) => ({
        id: decision.id,
        approved: decision.approved,
        reasons: decision.reasons,
        createdAt: decision.createdAt.toISOString(),
      })),
    snapshots: snapshots
      .map((row) => ({ t: row.capturedAt.getTime(), equityCents: row.equityCents }))
      .reverse(),
    spyBars: {
      daily: dailyBars.map(candle).reverse(),
      minute: minuteBars.map(candle).reverse(),
    },
  };
}

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

export type Desk = NonNullable<Awaited<ReturnType<typeof getDesk>>>;
