import { sessionClock } from "@/lib/market/calendar";
import { RISK_LIMITS, STRATEGY_NAME } from "@/lib/risk/constants";
import { riskBudgetCents } from "@/lib/risk/sizing";
import { alpacaPaperConfigured, alpacaStatus } from "@/server/alpaca";
import { prisma } from "@/server/db";
import { robinhoodStatus } from "@/server/robinhood";
import { alignAlpaca, readHeartbeat } from "@/server/trading";

export async function getDesk() {
  const now = new Date();
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
      trades: { orderBy: { openedAt: "desc" }, take: 60 },
      orders: { orderBy: { createdAt: "desc" }, take: 80 },
      snapshots: { orderBy: { capturedAt: "desc" }, take: 1500 },
      events: { orderBy: { createdAt: "desc" }, take: 40 },
      decisions: { orderBy: { createdAt: "desc" }, take: 12 },
      sessions: { orderBy: { sessionDate: "desc" }, take: 1 },
    },
  });
  if (!account) return null;

  const clock = sessionClock(now);
  const heartbeat = readHeartbeat();
  const spy = heartbeat?.spy ?? account.snapshots.find((snapshot) => snapshot.spyPrice)?.spyPrice ?? null;
  const dayPnlCents = account.equityCents - account.dayStartEquityCents;
  const weekPnlCents = account.equityCents - account.weekStartEquityCents;
  const openTrades = account.trades.filter((trade) => trade.status === "OPEN");
  const openRiskCents = openTrades
    .filter((trade) => trade.origin === "ENGINE")
    .reduce((sum, trade) => sum + Math.round(Math.abs(trade.entryPrice - trade.stopPrice) * trade.quantity * 100), 0);

  const [dailyBars, minuteBars] = await Promise.all([
    prisma.marketBar.findMany({
      where: { accountId: account.id, symbol: "SPY", timeframe: "1d" },
      orderBy: { ts: "desc" },
      take: 140,
    }),
    prisma.marketBar.findMany({
      where: { accountId: account.id, symbol: "SPY", timeframe: "1m" },
      orderBy: { ts: "desc" },
      take: 500,
    }),
  ]);

  return {
    demo: account.demo,
    mode: account.mode,
    paused: account.agentPaused,
    haltReason: account.haltReason,
    shortingEnabled: account.shortingEnabled,
    strategy: STRATEGY_NAME,
    clock: {
      phase: clock.phase,
      label: clock.label,
      dateKey: clock.dateKey,
      tradingDay: clock.tradingDay,
    },
    spy,
    equityCents: account.equityCents,
    cashCents: account.cashCents,
    peakEquityCents: account.peakEquityCents,
    dayPnlCents,
    weekPnlCents,
    dailyLossRemainingCents: riskBudgetCents(account.dayStartEquityCents, RISK_LIMITS.maxDailyLoss) + dayPnlCents,
    weeklyLossRemainingCents: riskBudgetCents(account.weekStartEquityCents, RISK_LIMITS.maxWeeklyLoss) + weekPnlCents,
    drawdown: account.peakEquityCents > 0 ? (account.peakEquityCents - account.equityCents) / account.peakEquityCents : 0,
    openRiskCents,
    openRiskLimitCents: riskBudgetCents(account.equityCents, RISK_LIMITS.maxTotalOpenRisk),
    tradesToday: account.sessions[0]?.sessionDate === clock.dateKey ? account.sessions[0].tradesTaken : 0,
    heartbeat,
    robinhood: robinhoodStatus(),
    alpaca: alpacaStatus(),
    limits: RISK_LIMITS,
    session: account.sessions[0]
      ? {
          date: account.sessions[0].sessionDate,
          orHigh: account.sessions[0].orHigh,
          orLow: account.sessions[0].orLow,
          vwap: account.sessions[0].vwap,
          standDown: account.sessions[0].standDown,
          consecutiveLosses: account.sessions[0].consecutiveLosses,
          longStopped: account.sessions[0].longStopped,
        }
      : null,
    holdings: account.holdings.map((holding) => {
      const mark = holding.symbol === "SPY" && spy ? spy : holding.marketPrice;
      return {
        symbol: holding.symbol,
        quantity: holding.quantity,
        averagePrice: holding.averagePrice,
        marketPrice: mark,
        origin: holding.origin,
        tradable: holding.tradable,
        marketValueCents: Math.round(holding.quantity * mark * 100),
        unrealizedCents: Math.round((mark - holding.averagePrice) * holding.quantity * 100),
      };
    }),
    openTrades: openTrades.map((trade) => ({
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
      unrealizedCents: Math.round(((spy ?? trade.entryPrice) - trade.entryPrice) * trade.quantity * (trade.side === "LONG" ? 1 : -1) * 100),
    })),
    recentTrades: account.trades.map((trade) => ({
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
      openedAt: trade.openedAt.toISOString(),
      closedAt: trade.closedAt?.toISOString() ?? null,
    })),
    orders: account.orders.map((order) => ({
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
    events: account.events.map((event) => ({
      id: event.id,
      level: event.level,
      kind: event.kind,
      message: event.message,
      createdAt: event.createdAt.toISOString(),
    })),
    decisions: account.decisions.map((decision) => ({
      id: decision.id,
      approved: decision.approved,
      reasons: decision.reasons,
      createdAt: decision.createdAt.toISOString(),
    })),
    snapshots: account.snapshots
      .map((snapshot) => ({ t: snapshot.capturedAt.getTime(), equityCents: snapshot.equityCents }))
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
