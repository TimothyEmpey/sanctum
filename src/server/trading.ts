import fs from "node:fs";
import path from "node:path";
import type { Account, Holding, StrategySession, Trade } from "@prisma/client";
import { assertAgentExit, assertTradableSymbol } from "@/lib/broker/firewall";
import { isStrategyBar } from "@/lib/market/bars";
import { previousBusinessDays, sessionClock, weekKey, type SessionClock } from "@/lib/market/calendar";
import { etParts, roundPrice } from "@/lib/market/time";
import { accountEquityCents } from "@/lib/portfolio/equity";
import { RISK_LIMITS, STRATEGY_ID, TRADABLE_SYMBOL } from "@/lib/risk/constants";
import { evaluateRisk, haltReasonForState } from "@/lib/risk/engine";
import { dollarRiskCents, notionalCents, sharesForRisk } from "@/lib/risk/sizing";
import { stopChangeAllowed } from "@/lib/risk/stops";
import type { RiskState, Side } from "@/lib/risk/types";
import { evaluateTrendPullback, type Bar, type TrendProposal } from "@/lib/strategy/trend-pullback";
import { prisma } from "@/server/db";
import { deterministicJournal, maybeNarrate } from "@/server/journal";
import {
  alpacaPaperConfigured,
  cancelPaperOrder,
  getPaperOrder,
  placePaperBracket,
  replacePaperStop,
  sellPaperShares,
  syncAlpacaPaper,
} from "@/server/alpaca";
import { fetchYahooBars } from "@/server/market";

const HEARTBEAT_PATH = path.join(process.cwd(), "data", "heartbeat.json");
let lastQuoteFetch = 0;
let lastHoldingFetch = 0;
let lastHeartbeatEvent = 0;

export type Heartbeat = {
  at: string;
  phase: string;
  label: string;
  spy: number | null;
  paused: boolean;
  haltReason: string | null;
  mode: string;
};

export function readHeartbeat(): Heartbeat | null {
  try {
    return JSON.parse(fs.readFileSync(HEARTBEAT_PATH, "utf8")) as Heartbeat;
  } catch {
    return null;
  }
}

function writeHeartbeat(beat: Heartbeat) {
  fs.mkdirSync(path.dirname(HEARTBEAT_PATH), { recursive: true });
  fs.writeFileSync(HEARTBEAT_PATH, JSON.stringify(beat, null, 2));
}

async function latestSpy(accountId: string) {
  const minute = await prisma.marketBar.findFirst({
    where: { accountId, symbol: TRADABLE_SYMBOL, timeframe: "1m" },
    orderBy: { ts: "desc" },
  });
  if (minute) return minute;
  return prisma.marketBar.findFirst({
    where: { accountId, symbol: TRADABLE_SYMBOL, timeframe: "1d" },
    orderBy: { ts: "desc" },
  });
}

async function ingestSymbol(accountId: string, symbol: string, interval: "1m" | "1d", range: string, all = false) {
  const bars = await fetchYahooBars(symbol, interval, range);
  if (interval === "1m") {
    await prisma.$executeRaw`
      DELETE FROM "MarketBar"
      WHERE "accountId" = ${accountId}
        AND symbol = ${symbol}
        AND timeframe = '1m'
        AND EXTRACT(SECOND FROM ts) <> 0
    `;
  }
  const latest = await prisma.marketBar.findFirst({
    where: { accountId, symbol, timeframe: interval },
    orderBy: { ts: "desc" },
  });
  const fresh = all ? bars : bars.filter((bar) => !latest || bar.ts >= latest.ts.getTime());
  for (const bar of fresh) {
    const volume = Math.min(2_000_000_000, Math.max(0, Math.round(bar.volume)));
    await prisma.marketBar.upsert({
      where: { accountId_symbol_ts_timeframe: { accountId, symbol, ts: new Date(bar.ts), timeframe: interval } },
      create: {
        accountId,
        symbol,
        ts: new Date(bar.ts),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume,
        timeframe: interval,
      },
      update: { high: bar.high, low: bar.low, close: bar.close, volume, timeframe: interval },
    });
  }
  return bars.at(-1)?.close ?? null;
}

export async function refreshMarket(accountId: string, clock: SessionClock, now: Date) {
  const active = ["preopen", "opening_range", "entry", "manage", "flatten"].includes(clock.phase);
  if (active || now.getTime() - lastQuoteFetch > 5 * 60_000) {
    lastQuoteFetch = now.getTime();
    await ingestSymbol(accountId, TRADABLE_SYMBOL, active ? "1m" : "1d", active ? "1d" : "5d");
  }
  if (!active) {
    const dailyCount = await prisma.marketBar.count({
      where: { accountId, symbol: TRADABLE_SYMBOL, timeframe: "1d" },
    });
    if (dailyCount < 80) await ingestSymbol(accountId, TRADABLE_SYMBOL, "1d", "6mo", true);
  }
  if (now.getTime() - lastHoldingFetch > 60 * 60_000) {
    lastHoldingFetch = now.getTime();
    const holdings = await prisma.holding.findMany({ where: { accountId, symbol: { not: TRADABLE_SYMBOL } } });
    for (const holding of holdings) {
      try {
        const bars = await fetchYahooBars(holding.symbol, "1d", "5d");
        const mark = bars.at(-1)?.close;
        if (mark) {
          await prisma.holding.update({ where: { id: holding.id }, data: { marketPrice: mark } });
        }
      } catch {
        // A missed quote must not become an order, and it must not throw the loop.
      }
    }
  }
}

function markedEquity(input: {
  cashCents: number;
  holdings: Holding[];
  trades: Trade[];
  spy: number | null;
}) {
  return accountEquityCents({
    cashCents: input.cashCents,
    holdings: input.holdings.map((holding) => ({
      quantity: holding.quantity,
      mark: holding.symbol === TRADABLE_SYMBOL && input.spy ? input.spy : holding.marketPrice,
    })),
    openTrades: input.trades
      .filter((trade) => trade.origin === "ENGINE" && trade.status === "OPEN")
      .map((trade) => ({
        side: trade.side as Side,
        quantity: trade.quantity,
        mark: input.spy ?? trade.entryPrice,
      })),
  });
}

async function loadBook(accountId: string) {
  const [account, holdings, trades, sessionBars] = await Promise.all([
    prisma.account.findUniqueOrThrow({ where: { id: accountId } }),
    prisma.holding.findMany({ where: { accountId } }),
    prisma.trade.findMany({ where: { accountId, status: "OPEN", origin: "ENGINE" } }),
    latestSpy(accountId),
  ]);
  const spy = sessionBars?.close ?? null;
  const equityCents = markedEquity({ cashCents: account.cashCents, holdings, trades, spy });
  return { account, holdings, trades, spy, equityCents };
}

async function dayTradeCount(accountId: string, dateKey: string) {
  const window = new Set([dateKey, ...previousBusinessDays(dateKey, 4)]);
  const trades = await prisma.trade.findMany({
    where: { accountId, origin: "ENGINE", closedAt: { not: null } },
    select: { openedAt: true, closedAt: true },
  });
  return trades.filter((trade) => {
    if (!trade.closedAt) return false;
    const opened = etParts(trade.openedAt).dateKey;
    const closed = etParts(trade.closedAt).dateKey;
    return opened === closed && window.has(opened);
  }).length;
}

async function riskState(account: Account, session: StrategySession, equityCents: number, clock: SessionClock): Promise<RiskState> {
  const open = await prisma.trade.findMany({
    where: { accountId: account.id, status: "OPEN", origin: "ENGINE" },
  });
  const workingEntries = await prisma.order.findMany({
    where: { accountId: account.id, status: "WORKING", purpose: "ENTRY", symbol: TRADABLE_SYMBOL },
  });
  const openRiskCents =
    open.reduce((sum, trade) => sum + dollarRiskCents(trade.quantity, trade.entryPrice, trade.stopPrice), 0) +
    workingEntries.reduce((sum, order) => {
      if (order.limitPrice == null || order.stopPrice == null) return sum;
      return sum + dollarRiskCents(order.quantity, order.limitPrice, order.stopPrice);
    }, 0);
  return {
    equityCents,
    cashCents: account.cashCents,
    peakEquityCents: Math.max(account.peakEquityCents, equityCents),
    dayStartEquityCents: account.dayStartEquityCents,
    weekStartEquityCents: account.weekStartEquityCents,
    openPositions: open.length + workingEntries.length,
    openRiskCents,
    tradesToday: session.tradesTaken,
    consecutiveLosses: session.consecutiveLosses,
    lastTradeWasLoss: session.lastTradeWasLoss,
    lastTradeShares: session.lastTradeShares,
    agentPaused: account.agentPaused,
    haltReason: account.haltReason,
    spyPositionOpen: open.some((trade) => trade.symbol === TRADABLE_SYMBOL) || workingEntries.length > 0,
    shortingEnabled: account.shortingEnabled,
    dayTradesInPdtWindow: await dayTradeCount(account.id, clock.dateKey),
  };
}

async function ensureSession(accountId: string, dateKey: string) {
  return prisma.strategySession.upsert({
    where: { accountId_sessionDate: { accountId, sessionDate: dateKey } },
    create: { accountId, sessionDate: dateKey },
    update: {},
  });
}

async function logEvent(accountId: string, kind: string, message: string, level = "info", payload?: object) {
  await prisma.agentEvent.create({
    data: { accountId, kind, message, level, payload: payload ?? undefined },
  });
}

async function snapshot(accountId: string, equityCents: number, cashCents: number, spy: number | null, now: Date) {
  const recent = await prisma.equitySnapshot.findFirst({
    where: { accountId },
    orderBy: { capturedAt: "desc" },
  });
  const sameValue = recent != null && Math.abs(recent.equityCents - equityCents) < 100;
  if (recent && sameValue && now.getTime() - recent.capturedAt.getTime() < 15 * 60_000) return;
  await prisma.equitySnapshot.create({
    data: { accountId, equityCents, cashCents, spyPrice: spy, capturedAt: now },
  });
}

async function closeTrade(
  trade: Trade,
  exitPrice: number,
  purpose: string,
  now: Date,
  options?: { adjustCash?: boolean; recordExitOrder?: boolean },
) {
  const adjustCash = options?.adjustCash !== false;
  const recordExitOrder = options?.recordExitOrder !== false;
  assertAgentExit({
    symbol: trade.symbol,
    quantity: trade.quantity,
    agentQuantity: trade.quantity,
    baselineQuantity: 0,
  });
  const price = roundPrice(exitPrice);
  const pnl = Math.round((trade.side === "LONG" ? price - trade.entryPrice : trade.entryPrice - price) * trade.quantity * 100);
  const risk = Math.abs(trade.entryPrice - trade.initialStopPrice);
  const moved = trade.side === "LONG" ? price - trade.entryPrice : trade.entryPrice - price;
  const summary = deterministicJournal({
    side: trade.side as Side,
    quantity: trade.quantity,
    entry: trade.entryPrice,
    exit: price,
    stop: trade.stopPrice,
    setup: trade.setup,
  });
  const closedToday = await prisma.trade.count({
    where: {
      accountId: trade.accountId,
      origin: "ENGINE",
      closedAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      journal: { not: null },
    },
  });
  const narrative = closedToday < 3 ? await maybeNarrate(summary) : null;
  const cashDelta = trade.side === "LONG" ? notionalCents(trade.quantity, price) : -notionalCents(trade.quantity, price);

  await prisma.$transaction(async (tx) => {
    const closed = await tx.trade.updateMany({
      where: { id: trade.id, status: "OPEN" },
      data: {
        status: "CLOSED",
        exitPrice: price,
        realizedPnlCents: pnl,
        rMultiple: risk > 0 ? moved / risk : null,
        closedAt: now,
        journal: narrative ? `${summary} ${narrative}` : summary,
      },
    });
    if (closed.count !== 1) return;
    if (recordExitOrder) {
      await tx.order.create({
        data: {
          accountId: trade.accountId,
          tradeId: trade.id,
          symbol: trade.symbol,
          side: trade.side === "LONG" ? "SELL" : "BUY",
          type: purpose === "STOP" ? "STOP" : "MARKET",
          purpose,
          quantity: trade.quantity,
          stopPrice: purpose === "STOP" ? trade.stopPrice : null,
          fillPrice: price,
          status: "FILLED",
          filledAt: now,
        },
      });
    }
    await tx.order.updateMany({
      where: { tradeId: trade.id, purpose: "STOP", status: "WORKING" },
      data: { status: purpose === "STOP" ? "FILLED" : "CANCELLED", fillPrice: purpose === "STOP" ? price : null, filledAt: now },
    });
    const session = await tx.strategySession.findUnique({
      where: { accountId_sessionDate: { accountId: trade.accountId, sessionDate: etParts(trade.openedAt).dateKey } },
    });
    const loss = pnl < 0;
    if (session) {
      await tx.strategySession.update({
        where: { id: session.id },
        data: {
          consecutiveLosses: loss ? session.consecutiveLosses + 1 : 0,
          longStopped: loss && trade.side === "LONG" ? true : session.longStopped,
          lastTradeWasLoss: loss,
          lastTradeShares: trade.quantity,
        },
      });
    }
    if (adjustCash) {
      await tx.account.update({
        where: { id: trade.accountId },
        data: { cashCents: { increment: cashDelta } },
      });
    }
    await tx.agentEvent.create({
      data: {
        accountId: trade.accountId,
        kind: "EXIT",
        level: "info",
        message: `${purpose} ${trade.quantity} ${trade.symbol} at ${price.toFixed(2)}.`,
        payload: { pnlCents: pnl, tradeId: trade.id },
      },
    });
  });
}

async function manageOpenTrades(accountId: string, now: Date) {
  const clock = sessionClock(now);
  const trades = await prisma.trade.findMany({ where: { accountId, status: "OPEN", origin: "ENGINE" } });
  const bars = await prisma.marketBar.findMany({
    where: { accountId, symbol: TRADABLE_SYMBOL, timeframe: "1m", ts: { gte: new Date(`${clock.dateKey}T00:00:00Z`) } },
    orderBy: { ts: "asc" },
  });
  const today = bars.filter((bar) => isStrategyBar(bar.timeframe) && etParts(bar.ts).dateKey === clock.dateKey);

  for (const trade of trades) {
    let stop = trade.initialStopPrice;
    let exit: { price: number; purpose: string } | null = null;
    for (const bar of today) {
      if (bar.ts < trade.openedAt) continue;
      if (trade.side === "LONG") {
        if (bar.low <= stop) {
          exit = { price: stop, purpose: "STOP" };
          break;
        }
        if (bar.high >= trade.targetPrice) {
          exit = { price: trade.targetPrice, purpose: "TARGET" };
          break;
        }
        const oneR = trade.entryPrice + (trade.entryPrice - trade.initialStopPrice);
        if (bar.high >= oneR) {
          const change = stopChangeAllowed("LONG", trade.entryPrice, stop, trade.entryPrice);
          if (change.ok) stop = trade.entryPrice;
        }
      }
    }
    if (exit) {
      await closeTrade(trade, exit.price, exit.purpose, now);
      continue;
    }
    if (Math.abs(stop - trade.stopPrice) > 0.001) {
      const change = stopChangeAllowed(trade.side as Side, trade.entryPrice, trade.stopPrice, stop);
      if (change.ok) {
        await prisma.trade.update({ where: { id: trade.id }, data: { stopPrice: stop } });
        await logEvent(accountId, "STOP", `Stop tightened to ${stop.toFixed(2)} on ${trade.quantity} ${trade.symbol}.`);
      }
    }
  }
}

export async function flattenAgentTrades(accountId: string, now = new Date(), purpose = "FLATTEN") {
  const open = await prisma.trade.findMany({ where: { accountId, status: "OPEN", origin: "ENGINE" } });
  const spy = await latestSpy(accountId);
  if (alpacaPaperConfigured()) {
    const working = await prisma.order.findMany({
      where: { accountId, status: "WORKING", brokerOrderId: { not: null } },
    });
    for (const order of working) {
      if (!order.brokerOrderId) continue;
      try {
        await cancelPaperOrder(order.brokerOrderId);
      } catch {
        // A missing or already-closed order should not block the flatten.
      }
      await prisma.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    }
    for (const trade of open) {
      assertAgentExit({
        symbol: trade.symbol,
        quantity: trade.quantity,
        agentQuantity: trade.quantity,
        baselineQuantity: 0,
      });
      await sellPaperShares(trade.quantity);
      await closeTrade(trade, spy?.close ?? trade.entryPrice, purpose, now, { adjustCash: false });
    }
    return open.length;
  }
  for (const trade of open) {
    await closeTrade(trade, spy?.close ?? trade.entryPrice, purpose, now);
  }
  return open.length;
}

async function executeProposal(
  account: Account,
  session: StrategySession,
  equityCents: number,
  clock: SessionClock,
  proposal: TrendProposal,
  spy: number,
  now: Date,
) {
  if (session.lastSignalBarTs?.getTime() === proposal.signalBarTs) return;
  const sized = sharesForRisk(equityCents, proposal.entryPrice, proposal.stopPrice);
  const decision = evaluateRisk(
    {
      symbol: proposal.symbol,
      side: proposal.side,
      entryPrice: proposal.entryPrice,
      stopPrice: proposal.stopPrice,
      targetPrice: proposal.targetPrice,
      requestedShares: sized.shares,
      setup: proposal.setup,
      now,
    },
    await riskState({ ...account, equityCents } as Account, session, equityCents, clock),
  );
  await prisma.riskDecisionRecord.create({
    data: {
      accountId: account.id,
      approved: decision.approved,
      proposal: { ...proposal, requestedShares: sized.shares },
      computed: decision.computed,
      reasons: decision.reasons,
    },
  });
  if (!decision.approved) {
    await prisma.strategySession.update({
      where: { id: session.id },
      data: { lastSignalBarTs: new Date(proposal.signalBarTs) },
    });
    await logEvent(account.id, "RISK_BLOCK", decision.reasons.join(" "), "warn", { setup: proposal.setup });
    return;
  }

  assertTradableSymbol(proposal.symbol);
  const fill = roundPrice(Math.min(proposal.entryPrice, spy + 0.01));
  const cost = notionalCents(decision.shares, fill);
  if (proposal.side !== "LONG") {
    await logEvent(account.id, "RISK_BLOCK", "Live and paper execution are long-only.", "warn");
    return;
  }

  if (alpacaPaperConfigured()) {
    try {
      const placed = await placePaperBracket({
        symbol: proposal.symbol,
        quantity: decision.shares,
        limitPrice: proposal.entryPrice,
        stopPrice: proposal.stopPrice,
        targetPrice: proposal.targetPrice,
        clientOrderId: `uriel-${proposal.signalBarTs}`,
      });
      await prisma.order.create({
        data: {
          accountId: account.id,
          symbol: proposal.symbol,
          side: "BUY",
          type: "LIMIT",
          purpose: "ENTRY",
          quantity: decision.shares,
          limitPrice: proposal.entryPrice,
          stopPrice: proposal.stopPrice,
          status: "WORKING",
          brokerOrderId: placed.id,
        },
      });
      await prisma.strategySession.update({
        where: { id: session.id },
        data: { tradesTaken: { increment: 1 }, lastSignalBarTs: new Date(proposal.signalBarTs) },
      });
      await logEvent(
        account.id,
        "ENTRY",
        `Submitted ${decision.shares} SPY to Alpaca paper. Limit ${proposal.entryPrice.toFixed(2)}, stop ${proposal.stopPrice.toFixed(2)}.`,
      );
    } catch (error) {
      await prisma.strategySession.update({
        where: { id: session.id },
        data: { lastSignalBarTs: new Date(proposal.signalBarTs) },
      });
      await logEvent(account.id, "BROKER", error instanceof Error ? error.message : "Alpaca paper rejected the order.", "warn");
    }
    return;
  }

  await prisma.$transaction(async (tx) => {
    const fresh = await tx.account.findUniqueOrThrow({ where: { id: account.id } });
    if (fresh.cashCents < cost) throw new Error("Cash changed before the fill.");
    const trade = await tx.trade.create({
      data: {
        accountId: account.id,
        symbol: proposal.symbol,
        side: "LONG",
        quantity: decision.shares,
        entryPrice: fill,
        stopPrice: proposal.stopPrice,
        initialStopPrice: proposal.stopPrice,
        targetPrice: proposal.targetPrice,
        status: "OPEN",
        setup: proposal.setup,
        strategy: proposal.strategy,
        origin: "ENGINE",
        notes: proposal.reason,
        openedAt: now,
      },
    });
    await tx.order.create({
      data: {
        accountId: account.id,
        tradeId: trade.id,
        symbol: proposal.symbol,
        side: "SELL",
        type: "STOP",
        purpose: "STOP",
        quantity: decision.shares,
        stopPrice: proposal.stopPrice,
        status: "WORKING",
      },
    });
    await tx.order.create({
      data: {
        accountId: account.id,
        tradeId: trade.id,
        symbol: proposal.symbol,
        side: "BUY",
        type: "LIMIT",
        purpose: "ENTRY",
        quantity: decision.shares,
        limitPrice: proposal.entryPrice,
        fillPrice: fill,
        status: "FILLED",
        filledAt: now,
      },
    });
    await tx.account.update({
      where: { id: account.id },
      data: { cashCents: { decrement: cost } },
    });
    await tx.strategySession.update({
      where: { id: session.id },
      data: { tradesTaken: { increment: 1 }, lastSignalBarTs: new Date(proposal.signalBarTs) },
    });
    await tx.agentEvent.create({
      data: {
        accountId: account.id,
        kind: "ENTRY",
        level: "info",
        message: `Bought ${decision.shares} SPY at ${fill.toFixed(2)}. Stop is working at ${proposal.stopPrice.toFixed(2)}.`,
      },
    });
  });
}

const CLOSED_ORDER = new Set(["canceled", "expired", "rejected", "replaced", "done_for_day"]);

async function reconcileAlpaca(accountId: string, now: Date) {
  const entries = await prisma.order.findMany({
    where: { accountId, status: "WORKING", purpose: "ENTRY", brokerOrderId: { not: null } },
  });
  for (const order of entries) {
    if (!order.brokerOrderId || order.limitPrice == null || order.stopPrice == null) continue;
    const remote = await getPaperOrder(order.brokerOrderId);
    if (remote.status === "filled") {
      const fill = roundPrice(Number(remote.filled_avg_price ?? order.limitPrice));
      const stopLeg = remote.legs?.find((leg) => leg.type === "stop" || leg.stop_price);
      const targetLeg = remote.legs?.find((leg) => leg.type === "limit" && leg.side === "sell");
      const stop = roundPrice(Number(stopLeg?.stop_price ?? order.stopPrice));
      const risk = Math.max(0.01, fill - stop);
      const target = roundPrice(Number(targetLeg?.limit_price ?? fill + risk * 1.5));
      const quantity = Number(remote.filled_qty ?? order.quantity);
      await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Order" WHERE id = ${order.id} AND status = 'WORKING' FOR UPDATE
        `;
        if (locked.length === 0) return;
        const trade = await tx.trade.create({
          data: {
            accountId,
            symbol: order.symbol,
            side: "LONG",
            quantity,
            entryPrice: fill,
            stopPrice: stop,
            initialStopPrice: stop,
            targetPrice: target,
            status: "OPEN",
            setup: "TREND_PULLBACK",
            strategy: STRATEGY_ID,
            origin: "ENGINE",
            openedAt: now,
          },
        });
        await tx.order.update({
          where: { id: order.id },
          data: { status: "FILLED", fillPrice: fill, filledAt: now, tradeId: trade.id },
        });
        for (const leg of remote.legs ?? []) {
          if (!leg.id) continue;
          const existing = await tx.order.findFirst({ where: { brokerOrderId: leg.id } });
          if (existing) continue;
          const purpose = leg.type === "stop" || leg.stop_price ? "STOP" : "TARGET";
          await tx.order.create({
            data: {
              accountId,
              tradeId: trade.id,
              symbol: order.symbol,
              side: "SELL",
              type: purpose === "STOP" ? "STOP" : "LIMIT",
              purpose,
              quantity,
              stopPrice: purpose === "STOP" ? stop : null,
              limitPrice: purpose === "TARGET" ? target : null,
              status: "WORKING",
              brokerOrderId: leg.id,
            },
          });
        }
        await tx.agentEvent.create({
          data: {
            accountId,
            kind: "ENTRY",
            level: "info",
            message: `Alpaca paper filled ${quantity} SPY at ${fill.toFixed(2)}.`,
          },
        });
      });
    } else if (CLOSED_ORDER.has(remote.status)) {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: "CANCELLED", rejectReason: remote.status },
      });
      await logEvent(accountId, "BROKER", `Alpaca paper entry ${remote.status}.`, "warn");
    }
  }

  const legs = await prisma.order.findMany({
    where: { accountId, status: "WORKING", purpose: { in: ["STOP", "TARGET"] }, brokerOrderId: { not: null } },
  });
  for (const leg of legs) {
    if (!leg.brokerOrderId || !leg.tradeId) continue;
    const remote = await getPaperOrder(leg.brokerOrderId);
    if (remote.status !== "filled") continue;
    const trade = await prisma.trade.findUnique({ where: { id: leg.tradeId } });
    if (!trade || trade.status !== "OPEN") continue;
    const fill = roundPrice(Number(remote.filled_avg_price ?? leg.stopPrice ?? leg.limitPrice ?? trade.stopPrice));
    const claimed = await prisma.order.updateMany({
      where: { id: leg.id, status: "WORKING" },
      data: { status: "FILLED", fillPrice: fill, filledAt: now },
    });
    if (claimed.count !== 1) continue;
    await closeTrade(trade, fill, leg.purpose, now, { adjustCash: false, recordExitOrder: false });
  }

  const open = await prisma.trade.findMany({ where: { accountId, status: "OPEN", origin: "ENGINE" } });
  if (open.length === 0) return;
  const clock = sessionClock(now);
  const bars = await prisma.marketBar.findMany({
    where: { accountId, symbol: TRADABLE_SYMBOL, timeframe: "1m", ts: { gte: new Date(`${clock.dateKey}T00:00:00Z`) } },
    orderBy: { ts: "asc" },
  });
  for (const trade of open) {
    let stop = trade.stopPrice;
    for (const bar of bars) {
      if (bar.ts < trade.openedAt || etParts(bar.ts).dateKey !== clock.dateKey) continue;
      const oneR = trade.entryPrice + (trade.entryPrice - trade.initialStopPrice);
      if (bar.high < oneR) continue;
      const change = stopChangeAllowed("LONG", trade.entryPrice, stop, trade.entryPrice);
      if (change.ok) stop = trade.entryPrice;
    }
    if (Math.abs(stop - trade.stopPrice) <= 0.001) continue;
    const stopOrder = await prisma.order.findFirst({
      where: { tradeId: trade.id, purpose: "STOP", status: "WORKING", brokerOrderId: { not: null } },
    });
    if (!stopOrder?.brokerOrderId) continue;
    await replacePaperStop(stopOrder.brokerOrderId, stop);
    await prisma.trade.update({ where: { id: trade.id }, data: { stopPrice: stop } });
    await prisma.order.update({ where: { id: stopOrder.id }, data: { stopPrice: stop } });
    await logEvent(accountId, "STOP", `Stop tightened to ${stop.toFixed(2)} on ${trade.quantity} ${trade.symbol}.`);
  }
}

export async function alignAlpaca(accountId: string, now = new Date()) {
  await reconcileAlpaca(accountId, now);
  await syncAlpacaPaper(accountId, now);
}

export async function tick(now = new Date()): Promise<{ ok: true; beat: Heartbeat } | { ok: false; reason: string }> {
  let account = await prisma.account.findFirst();
  if (!account) return { ok: false, reason: "No account" };
  const clock = sessionClock(now);
  try {
    await refreshMarket(account.id, clock, now);
  } catch (error) {
    await logEvent(account.id, "MARKET", error instanceof Error ? error.message : "Market data failed", "warn");
  }
  if (alpacaPaperConfigured()) {
    try {
      await alignAlpaca(account.id, now);
      account = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    } catch (error) {
      await logEvent(account.id, "BROKER", error instanceof Error ? error.message : "Alpaca paper sync failed.", "warn");
    }
  }

  let book = await loadBook(account.id);
  let equityCents = account.mode === "ALPACA_PAPER" ? account.equityCents : book.equityCents;
  const peakEquityCents = Math.max(account.peakEquityCents, equityCents);
  let dayStartEquityCents = account.dayStartEquityCents;
  let dayStartDate = account.dayStartDate;
  let weekStartEquityCents = account.weekStartEquityCents;
  let weekStartDate = account.weekStartDate;
  let haltReason = account.haltReason;

  if (clock.tradingDay && clock.minutes >= 9 * 60 + 25 && dayStartDate !== clock.dateKey) {
    const week = weekKey(clock.dateKey);
    dayStartEquityCents = equityCents;
    dayStartDate = clock.dateKey;
    if (weekStartDate !== week) {
      weekStartEquityCents = equityCents;
      weekStartDate = week;
    }
    haltReason = null;
  }

  haltReason = haltReasonForState({
    equityCents,
    peakEquityCents,
    dayStartEquityCents,
    weekStartEquityCents,
  });

  await prisma.account.update({
    where: { id: account.id },
    data: { equityCents, peakEquityCents, dayStartEquityCents, dayStartDate, weekStartEquityCents, weekStartDate, haltReason },
  });

  if (clock.tradingDay) {
    if (account.mode !== "ALPACA_PAPER") await manageOpenTrades(account.id, now);
    if (haltReason || clock.flattenDue) {
      const session = await ensureSession(account.id, clock.dateKey);
      if (!session.flattened || haltReason) {
        const closed = await flattenAgentTrades(account.id, now, haltReason ? "HALT" : "FLATTEN");
        if (closed > 0) {
          await logEvent(account.id, "FLATTEN", haltReason ?? "Day-trade cutoff. SPY position closed.");
        }
        await prisma.strategySession.update({ where: { id: session.id }, data: { flattened: clock.flattenDue } });
      }
    }
  }

  book = await loadBook(account.id);
  equityCents = book.equityCents;
  const session = await ensureSession(account.id, clock.dateKey);
  if (clock.entryWindowOpen && book.spy && !account.agentPaused && !haltReason) {
    const stored = await prisma.marketBar.findMany({
      where: { accountId: account.id, symbol: TRADABLE_SYMBOL, timeframe: "1m" },
      orderBy: { ts: "asc" },
    });
    const bars: Bar[] = stored
      .filter((bar) => isStrategyBar(bar.timeframe) && etParts(bar.ts).dateKey === clock.dateKey)
      .map((bar) => ({
        ts: bar.ts.getTime(),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      }));
    const pendingEntry = await prisma.order.count({
      where: { accountId: account.id, status: "WORKING", purpose: "ENTRY", symbol: TRADABLE_SYMBOL },
    });
    const view = evaluateTrendPullback({
      now,
      bars,
      hasOpenPosition: book.trades.length > 0 || pendingEntry > 0,
      tradesTaken: session.tradesTaken,
      consecutiveLosses: session.consecutiveLosses,
      maxTrades: RISK_LIMITS.maxTradesPerDay,
    });
    await prisma.strategySession.update({
      where: { id: session.id },
      data: {
        orHigh: view.orHigh,
        orLow: view.orLow,
        vwap: view.vwap,
        standDown: view.standDown,
      },
    });
    if (view.standDown && session.standDown !== view.standDown) {
      await logEvent(account.id, "STAND_DOWN", view.standDown);
    }
    if (view.proposal) {
      const freshSession = await prisma.strategySession.findUniqueOrThrow({ where: { id: session.id } });
      const freshAccount = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
      await executeProposal(freshAccount, freshSession, equityCents, clock, view.proposal, book.spy, now);
    }
  }

  const finalBook = await loadBook(account.id);
  if (finalBook.spy) {
    await prisma.holding.updateMany({
      where: { accountId: account.id, symbol: TRADABLE_SYMBOL },
      data: { marketPrice: finalBook.spy },
    });
  }
  const finalEquity = account.mode === "ALPACA_PAPER" ? account.equityCents : finalBook.equityCents;
  const finalCash = account.mode === "ALPACA_PAPER" ? account.cashCents : finalBook.account.cashCents;
  await prisma.account.update({
    where: { id: account.id },
    data: {
      equityCents: finalEquity,
      peakEquityCents: Math.max(peakEquityCents, finalEquity),
    },
  });
  await snapshot(account.id, finalEquity, finalCash, finalBook.spy, now);

  const beat: Heartbeat = {
    at: now.toISOString(),
    phase: clock.phase,
    label: clock.label,
    spy: finalBook.spy,
    paused: account.agentPaused,
    haltReason,
    mode: account.mode,
  };
  writeHeartbeat(beat);
  if (now.getTime() - lastHeartbeatEvent > 10 * 60_000) {
    lastHeartbeatEvent = now.getTime();
    await logEvent(account.id, "HEARTBEAT", `${clock.label}. SPY ${finalBook.spy?.toFixed(2) ?? "—"}.`);
  }
  return { ok: true, beat };
}
