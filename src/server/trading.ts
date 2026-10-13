import fs from "node:fs";
import path from "node:path";
import type { Account, Prisma, StrategySession, Trade } from "@prisma/client";
import { ASSETS, assetBySymbol, assetShareCents, CRYPTO_ASSETS, CRYPTO_SYMBOLS, isSessionExitSetup, STOCK_ASSETS, STOCK_SYMBOLS, type Asset } from "@/lib/assets";
import { assertAgentExit, assertTradableSymbol } from "@/lib/broker/firewall";
import { isStrategyBar } from "@/lib/market/bars";
import { previousBusinessDays, retiredFlattenMinute, sessionClock, weekKey, type SessionClock } from "@/lib/market/calendar";
import { cryptoSessionClock, utcParts } from "@/lib/market/crypto-clock";
import { etInstant, etParts, formatQty, roundPrice } from "@/lib/market/time";
import { accountEquityCents } from "@/lib/portfolio/equity";
import { RISK_LIMITS, STRATEGY_ID } from "@/lib/risk/constants";
import { evaluateRisk, haltReasonForState } from "@/lib/risk/engine";
import { deployedNotionalCents, dollarRiskCents, notionalCents, quantityForRisk, sharesForRisk } from "@/lib/risk/sizing";
import { stopChangeAllowed } from "@/lib/risk/stops";
import type { RiskState, Side } from "@/lib/risk/types";
import { evaluateCryptoMomentum, type CryptoProposal } from "@/lib/strategy/crypto-momentum";
import {
  BROKER_CEILING_PCT,
  evaluateIntradayMomentum,
  MOMENTUM_SETUP,
  type MomentumProposal,
} from "@/lib/strategy/intraday-momentum";
import { evaluateQqqMomentum } from "@/lib/strategy/qqq-momentum";
import { prisma } from "@/server/db";
import { deterministicJournal, maybeNarrate } from "@/server/journal";
import {
  alpacaPaperConfigured,
  cancelPaperOrder,
  getPaperOrder,
  getPaperOrderByClientId,
  placePaperBracket,
  placePaperCryptoLimit,
  placePaperCryptoStop,
  replacePaperStop,
  sellPaperShares,
  syncAlpacaPaper,
} from "@/server/alpaca";
import { fetchYahooBars } from "@/server/market";

const HEARTBEAT_PATH = path.join(process.cwd(), "data", "heartbeat.json");
const FONZO_HEARTBEAT_PATH = path.join(process.cwd(), "data", "fonzo-heartbeat.json");
let lastStockFetch = 0;
let lastCryptoFetch = 0;
let lastHoldingFetch = 0;
let lastHeartbeatEvent = 0;
let lastFonzoHeartbeatEvent = 0;

export type Heartbeat = {
  at: string;
  phase: string;
  label: string;
  spy: number | null;
  qqq?: number | null;
  paused: boolean;
  haltReason: string | null;
  mode: string;
};

export type FonzoHeartbeat = {
  at: string;
  phase: string;
  label: string;
  btc: number | null;
  eth: number | null;
  paused: boolean;
  haltReason: string | null;
  mode: string;
};

type EntryProposal = MomentumProposal | CryptoProposal;

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readHeartbeat(): Heartbeat | null {
  return readJson<Heartbeat>(HEARTBEAT_PATH);
}

export function readFonzoHeartbeat(): FonzoHeartbeat | null {
  return readJson<FonzoHeartbeat>(FONZO_HEARTBEAT_PATH);
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function clientOrderId(asset: Asset, orderId: string) {
  return `${asset.desk}-${orderId}`.slice(0, 48);
}

function missingBrokerOrder(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /404|not found/i.test(message);
}

async function latestMark(accountId: string, symbol: string) {
  const minute = await prisma.marketBar.findFirst({
    where: { accountId, symbol, timeframe: "1m" },
    orderBy: { ts: "desc" },
  });
  if (minute) return minute.close;
  const daily = await prisma.marketBar.findFirst({
    where: { accountId, symbol, timeframe: "1d" },
    orderBy: { ts: "desc" },
  });
  return daily?.close ?? null;
}

async function ingestSymbol(
  accountId: string,
  brokerSymbol: string,
  yahooSymbol: string,
  interval: "1m" | "1d",
  range: string,
  all = false,
) {
  const bars = await fetchYahooBars(yahooSymbol, interval, range);
  if (interval === "1m") {
    await prisma.$executeRaw`
      DELETE FROM "MarketBar"
      WHERE "accountId" = ${accountId}
        AND symbol = ${brokerSymbol}
        AND timeframe = '1m'
        AND EXTRACT(SECOND FROM ts) <> 0
    `;
  }
  const latest = await prisma.marketBar.findFirst({
    where: { accountId, symbol: brokerSymbol, timeframe: interval },
    orderBy: { ts: "desc" },
  });
  const fresh = all ? bars : bars.filter((bar) => !latest || bar.ts >= latest.ts.getTime());
  const rows = fresh.map((bar) => ({
    accountId,
    symbol: brokerSymbol,
    ts: new Date(bar.ts),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: Math.min(2_000_000_000, Math.max(0, Math.round(bar.volume))),
    timeframe: interval,
  }));
  for (let index = 0; index < rows.length; index += 500) {
    await prisma.marketBar.createMany({ data: rows.slice(index, index + 500), skipDuplicates: true });
  }
  for (const row of rows.slice(-2)) {
    await prisma.marketBar.update({
      where: {
        accountId_symbol_ts_timeframe: { accountId, symbol: row.symbol, ts: row.ts, timeframe: interval },
      },
      data: { high: row.high, low: row.low, close: row.close, volume: row.volume },
    });
  }
  return bars.at(-1)?.close ?? null;
}

/** The chart needs minute bars after the session, and crypto keeps printing overnight. */
async function refreshIntraday(accountId: string, asset: Asset, now: Date) {
  const latest = await prisma.marketBar.findFirst({
    where: { accountId, symbol: asset.symbol, timeframe: "1m" },
    orderBy: { ts: "desc" },
  });
  const age = latest ? now.getTime() - latest.ts.getTime() : Number.POSITIVE_INFINITY;
  if (asset.market === "nyse" && latest && age < 7 * 24 * 60 * 60 * 1000) return;
  if (asset.market === "crypto" && latest && age < 5 * 60_000) return;
  const range = latest && age < 2 * 24 * 60 * 60 * 1000 ? "1d" : "5d";
  await ingestSymbol(accountId, asset.symbol, asset.yahoo, "1m", range);
}

async function refreshAssets(accountId: string, assets: Asset[], hot: boolean, now: Date, which: "stock" | "crypto") {
  const last = which === "stock" ? lastStockFetch : lastCryptoFetch;
  if (hot || now.getTime() - last > 5 * 60_000) {
    if (which === "stock") lastStockFetch = now.getTime();
    else lastCryptoFetch = now.getTime();
    for (const asset of assets) {
      await ingestSymbol(accountId, asset.symbol, asset.yahoo, hot ? "1m" : "1d", hot ? "1d" : "5d");
      if (!hot) await refreshIntraday(accountId, asset, now);
    }
  }
  if (!hot) {
    for (const asset of assets) {
      const dailyCount = await prisma.marketBar.count({
        where: { accountId, symbol: asset.symbol, timeframe: "1d" },
      });
      if (dailyCount < 80) await ingestSymbol(accountId, asset.symbol, asset.yahoo, "1d", "6mo", true);
    }
  }
  if (now.getTime() - lastHoldingFetch > 60 * 60_000) {
    lastHoldingFetch = now.getTime();
    const holdings = await prisma.holding.findMany({ where: { accountId } });
    for (const holding of holdings) {
      if (assetBySymbol(holding.symbol)) continue;
      try {
        const bars = await fetchYahooBars(holding.symbol, "1d", "5d");
        const mark = bars.at(-1)?.close;
        if (mark) await prisma.holding.update({ where: { id: holding.id }, data: { marketPrice: mark } });
      } catch {
        // A missed quote must not become an order, and it must not throw the loop.
      }
    }
  }
}

function sleeveEquity(cashCents: number, trades: Trade[], marks: Record<string, number>) {
  return accountEquityCents({
    cashCents,
    holdings: [],
    openTrades: trades
      .filter((trade) => trade.origin === "ENGINE" && trade.status === "OPEN")
      .map((trade) => ({
        side: trade.side as Side,
        quantity: trade.quantity,
        mark: marks[trade.symbol] ?? trade.entryPrice,
      })),
  });
}

async function loadBook(accountId: string) {
  const [account, holdings, trades] = await Promise.all([
    prisma.account.findUniqueOrThrow({ where: { id: accountId } }),
    prisma.holding.findMany({ where: { accountId } }),
    prisma.trade.findMany({ where: { accountId, status: "OPEN", origin: "ENGINE" } }),
  ]);
  const marks: Record<string, number> = {};
  for (const asset of ASSETS) {
    const mark = await latestMark(accountId, asset.symbol);
    if (mark != null) marks[asset.symbol] = mark;
  }
  return {
    account,
    holdings,
    trades,
    marks,
    equityCents: sleeveEquity(account.cashCents, trades, marks),
  };
}

async function dayTradeCount(accountId: string, dateKey: string) {
  const window = new Set([dateKey, ...previousBusinessDays(dateKey, 4)]);
  const start = etInstant(dateKey, 0, 0);
  const trades = await prisma.trade.findMany({
    where: { accountId, origin: "ENGINE", closedAt: { not: null }, symbol: { in: [...STOCK_SYMBOLS] } },
    select: { openedAt: true, closedAt: true },
  });
  const closed = trades.filter((trade) => {
    if (!trade.closedAt) return false;
    const opened = etParts(trade.openedAt).dateKey;
    const closedOn = etParts(trade.closedAt).dateKey;
    return opened === closedOn && window.has(opened);
  }).length;
  const openToday = await prisma.trade.count({
    where: { accountId, origin: "ENGINE", status: "OPEN", symbol: { in: [...STOCK_SYMBOLS] }, openedAt: { gte: start } },
  });
  const workingToday = await prisma.order.count({
    where: { accountId, status: "WORKING", purpose: "ENTRY", symbol: { in: [...STOCK_SYMBOLS] }, createdAt: { gte: start } },
  });
  return closed + openToday + workingToday;
}

async function riskState(
  account: Account,
  session: StrategySession,
  equityCents: number,
  clock: SessionClock,
  symbol: string,
  allowedSymbols: string[],
): Promise<RiskState> {
  const open = await prisma.trade.findMany({
    where: { accountId: account.id, status: "OPEN", origin: "ENGINE" },
  });
  const workingEntries = await prisma.order.findMany({
    where: { accountId: account.id, status: "WORKING", purpose: "ENTRY" },
  });
  const symbolWorking = workingEntries.filter((order) => order.symbol === symbol);
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
    spyPositionOpen: open.some((trade) => trade.symbol === symbol) || symbolWorking.length > 0,
    shortingEnabled: account.shortingEnabled,
    dayTradesInPdtWindow: await dayTradeCount(account.id, clock.dateKey),
    allowedSymbols,
    sleeveUsedCents: deployedNotionalCents(open, workingEntries, symbol),
  };
}

async function shareRoomCents(tx: Prisma.TransactionClient, accountId: string, symbol: string, equityCents: number) {
  const [trades, orders] = await Promise.all([
    tx.trade.findMany({ where: { accountId, symbol, status: "OPEN", origin: "ENGINE" } }),
    tx.order.findMany({ where: { accountId, symbol, status: "WORKING", purpose: "ENTRY" } }),
  ]);
  return Math.max(0, assetShareCents(equityCents) - deployedNotionalCents(trades, orders, symbol));
}

async function ensureSession(accountId: string, dateKey: string, symbol: string) {
  return prisma.strategySession.upsert({
    where: { accountId_sessionDate_symbol: { accountId, sessionDate: dateKey, symbol } },
    create: { accountId, sessionDate: dateKey, symbol },
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

function sessionDateFor(trade: Trade) {
  const asset = assetBySymbol(trade.symbol);
  if (asset?.market === "crypto") return trade.openedAt.toISOString().slice(0, 10);
  return etParts(trade.openedAt).dateKey;
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
      where: {
        accountId_sessionDate_symbol: {
          accountId: trade.accountId,
          sessionDate: sessionDateFor(trade),
          symbol: trade.symbol,
        },
      },
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
        message: `${purpose} ${formatQty(trade.quantity)} ${trade.symbol} at ${price.toFixed(2)}.`,
        payload: { pnlCents: pnl, tradeId: trade.id },
      },
    });
  });
}

async function releaseWorkingEntry(order: { id: string; accountId: string; quantity: number; limitPrice: number | null }, reason: string) {
  const reserved = order.limitPrice == null ? 0 : notionalCents(order.quantity, order.limitPrice);
  await prisma.$transaction(async (tx) => {
    const updated = await tx.order.updateMany({
      where: { id: order.id, status: "WORKING", purpose: "ENTRY" },
      data: { status: "CANCELLED", rejectReason: reason },
    });
    if (updated.count !== 1 || reserved === 0) return;
    await tx.account.update({
      where: { id: order.accountId },
      data: { cashCents: { increment: reserved } },
    });
  });
}

async function manageOpenTrades(accountId: string, now: Date, symbols: readonly string[]) {
  const clock = sessionClock(now);
  const utc = utcParts(now);
  const trades = await prisma.trade.findMany({
    where: { accountId, status: "OPEN", origin: "ENGINE", symbol: { in: [...symbols] } },
  });
  for (const trade of trades) {
    const asset = assetBySymbol(trade.symbol);
    const market = asset?.market === "crypto" ? "crypto" : "nyse";
    const dateKey = market === "crypto" ? utc.dateKey : clock.dateKey;
    const bars = await prisma.marketBar.findMany({
      where: { accountId, symbol: trade.symbol, timeframe: "1m" },
      orderBy: { ts: "asc" },
    });
    const today = bars.filter((bar) => {
      if (!isStrategyBar(bar.timeframe)) return false;
      const key = market === "crypto" ? bar.ts.toISOString().slice(0, 10) : etParts(bar.ts).dateKey;
      return key === dateKey;
    });
    let stop = trade.initialStopPrice;
    let exit: { price: number; purpose: string } | null = null;
    for (const bar of today) {
      if (bar.ts < trade.openedAt) continue;
      if (trade.side !== "LONG") continue;
      if (bar.low <= stop) {
        exit = { price: stop, purpose: "STOP" };
        break;
      }
      if (trade.setup !== "CRYPTO_LAST_HALF" && bar.high >= trade.targetPrice) {
        exit = { price: trade.targetPrice, purpose: "TARGET" };
        break;
      }
      if (isSessionExitSetup(trade.setup)) continue;
      const oneR = trade.entryPrice + (trade.entryPrice - trade.initialStopPrice);
      if (bar.high >= oneR) {
        const change = stopChangeAllowed("LONG", trade.entryPrice, stop, trade.entryPrice);
        if (change.ok) stop = trade.entryPrice;
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
        await logEvent(accountId, "STOP", `Stop tightened to ${stop.toFixed(2)} on ${formatQty(trade.quantity)} ${trade.symbol}.`);
      }
    }
  }
}

export async function flattenAgentTrades(
  accountId: string,
  now = new Date(),
  purpose = "FLATTEN",
  options?: { exceptSetup?: string; symbols?: string[] },
) {
  const open = await prisma.trade.findMany({ where: { accountId, status: "OPEN", origin: "ENGINE" } });
  const allowed = options?.symbols ? new Set(options.symbols) : null;
  const targets = open.filter((trade) => {
    if (allowed && !allowed.has(trade.symbol)) return false;
    if (options?.exceptSetup && trade.setup === options.exceptSetup) return false;
    return true;
  });
  const closed: string[] = [];
  if (!options?.exceptSetup && alpacaPaperConfigured()) {
    const entries = await prisma.order.findMany({
      where: {
        accountId,
        status: "WORKING",
        purpose: "ENTRY",
        ...(allowed ? { symbol: { in: [...allowed] } } : {}),
      },
    });
    for (const order of entries) {
      if (order.brokerOrderId) {
        try {
          await cancelPaperOrder(order.brokerOrderId);
        } catch {
          // A missing or already-closed order should not block the flatten.
        }
      }
      await releaseWorkingEntry(order, purpose);
    }
  }
  if (targets.length === 0) return closed;
  const targetIds = new Set(targets.map((trade) => trade.id));
  if (alpacaPaperConfigured()) {
    const working = await prisma.order.findMany({
      where: { accountId, status: "WORKING", brokerOrderId: { not: null } },
    });
    for (const order of working) {
      if (!order.brokerOrderId || order.purpose === "ENTRY") continue;
      if (allowed && !allowed.has(order.symbol)) continue;
      if (options?.exceptSetup && (!order.tradeId || !targetIds.has(order.tradeId))) continue;
      try {
        await cancelPaperOrder(order.brokerOrderId);
      } catch {
        // A missing or already-closed order should not block the flatten.
      }
      await prisma.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    }
    for (const trade of targets) {
      assertAgentExit({
        symbol: trade.symbol,
        quantity: trade.quantity,
        agentQuantity: trade.quantity,
        baselineQuantity: 0,
      });
      const asset = assetBySymbol(trade.symbol);
      const sold = await sellPaperShares(trade.symbol, trade.quantity);
      if (asset && !asset.wholeShares && sold.status !== "filled") {
        await logEvent(accountId, "BROKER", `${trade.symbol} flatten was not filled. It will retry.`, "warn");
        continue;
      }
      const mark = (await latestMark(accountId, trade.symbol)) ?? trade.entryPrice;
      await closeTrade(trade, mark, purpose, now);
      closed.push(trade.symbol);
    }
    return closed;
  }
  for (const trade of targets) {
    const mark = (await latestMark(accountId, trade.symbol)) ?? trade.entryPrice;
    await closeTrade(trade, mark, purpose, now);
    closed.push(trade.symbol);
  }
  return closed;
}

async function executeProposal(
  account: Account,
  session: StrategySession,
  equityCents: number,
  clock: SessionClock,
  proposal: EntryProposal,
  mark: number,
  now: Date,
  allowedSymbols: string[],
) {
  if (session.lastSignalBarTs?.getTime() === proposal.signalBarTs) return;
  const asset = assetBySymbol(proposal.symbol);
  if (!asset) return;
  const sized = asset.wholeShares
    ? sharesForRisk(equityCents, proposal.entryPrice, proposal.stopPrice)
    : quantityForRisk(equityCents, proposal.entryPrice, proposal.stopPrice, asset.quantityStep);
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
      market: asset.market,
      quantityStep: asset.quantityStep,
    },
    await riskState(account, session, equityCents, clock, proposal.symbol, allowedSymbols),
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
  if (proposal.side !== "LONG") {
    await logEvent(account.id, "RISK_BLOCK", "Live and paper execution are long-only.", "warn");
    return;
  }

  const reserved = notionalCents(decision.shares, proposal.entryPrice);
  if (alpacaPaperConfigured()) {
    let orderId: string | null = null;
    let placedId: string | null = null;
    try {
      const created = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ cashCents: number }>>`
          SELECT "cashCents" FROM "Account" WHERE id = ${account.id} FOR UPDATE
        `;
        const openEntry = await tx.order.findFirst({
          where: { accountId: account.id, symbol: proposal.symbol, status: "WORKING", purpose: "ENTRY" },
        });
        if (openEntry) return "entry" as const;
        if (rows[0].cashCents < reserved) return "cash" as const;
        if (reserved > (await shareRoomCents(tx, account.id, proposal.symbol, equityCents))) return "share" as const;
        await tx.account.update({
          where: { id: account.id },
          data: { cashCents: { decrement: reserved } },
        });
        return tx.order.create({
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
          },
        });
      });
      if (created === "entry" || created === "cash" || created === "share") {
        await prisma.strategySession.update({
          where: { id: session.id },
          data: { lastSignalBarTs: new Date(proposal.signalBarTs) },
        });
        await logEvent(
          account.id,
          "RISK_BLOCK",
          created === "cash"
            ? `Not enough cash in the working book for ${proposal.symbol}.`
            : created === "share"
              ? `${proposal.symbol} is designated 25% of account equity. This order does not fit that share.`
              : `${proposal.symbol} entry is already working.`,
          "warn",
        );
        return;
      }
      orderId = created.id;
      const placed =
        asset.market === "crypto"
          ? await placePaperCryptoLimit({
              symbol: proposal.symbol,
              quantity: decision.shares,
              limitPrice: proposal.entryPrice,
              clientOrderId: clientOrderId(asset, created.id),
            })
          : await placePaperBracket({
              symbol: proposal.symbol,
              quantity: decision.shares,
              limitPrice: proposal.entryPrice,
              stopPrice: proposal.stopPrice,
              targetPrice: proposal.targetPrice,
              clientOrderId: clientOrderId(asset, created.id),
            });
      placedId = placed.id;
      await prisma.order.update({ where: { id: created.id }, data: { brokerOrderId: placed.id } });
      await prisma.strategySession.update({
        where: { id: session.id },
        data: { tradesTaken: { increment: 1 }, lastSignalBarTs: new Date(proposal.signalBarTs) },
      });
      const exitLine = asset.market === "crypto" ? "Exit is 24:00 UTC." : "Exit is the cash close.";
      await logEvent(
        account.id,
        "ENTRY",
        `Submitted ${formatQty(decision.shares)} ${proposal.symbol} to Alpaca paper. Limit ${proposal.entryPrice.toFixed(2)}, stop ${proposal.stopPrice.toFixed(2)}. ${exitLine}`,
      );
    } catch (error) {
      if (orderId && placedId) {
        await prisma.order.update({ where: { id: orderId }, data: { brokerOrderId: placedId } }).catch(() => undefined);
      } else if (orderId) {
        const order = await prisma.order.findUnique({ where: { id: orderId } });
        if (order && order.status === "WORKING" && order.brokerOrderId == null) await releaseWorkingEntry(order, "REJECTED");
      }
      await prisma.strategySession.update({
        where: { id: session.id },
        data: { lastSignalBarTs: new Date(proposal.signalBarTs) },
      });
      await logEvent(account.id, "BROKER", error instanceof Error ? error.message : "Alpaca paper rejected the order.", "warn");
    }
    return;
  }

  const fill = roundPrice(Math.min(proposal.entryPrice, mark + 0.01));
  const cost = notionalCents(decision.shares, fill);
  await prisma.$transaction(async (tx) => {
    const fresh = await tx.account.findUniqueOrThrow({ where: { id: account.id } });
    if (fresh.cashCents < cost) throw new Error("Cash changed before the fill.");
    if (cost > (await shareRoomCents(tx, account.id, proposal.symbol, equityCents))) {
      throw new Error(`${proposal.symbol} is designated 25% of account equity. This order does not fit that share.`);
    }
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
        message: `Bought ${formatQty(decision.shares)} ${proposal.symbol} at ${fill.toFixed(2)}. Stop is working at ${proposal.stopPrice.toFixed(2)}.`,
      },
    });
  });
}

const CLOSED_ORDER = new Set(["canceled", "expired", "rejected", "replaced", "done_for_day"]);

async function recoverUnsentEntries(accountId: string, symbols: readonly string[], now: Date) {
  const cutoff = new Date(now.getTime() - 15_000);
  const orphans = await prisma.order.findMany({
    where: {
      accountId,
      status: "WORKING",
      purpose: "ENTRY",
      brokerOrderId: null,
      symbol: { in: [...symbols] },
      createdAt: { lt: cutoff },
    },
  });
  for (const order of orphans) {
    const asset = assetBySymbol(order.symbol);
    if (!asset) continue;
    try {
      const remote = await getPaperOrderByClientId(clientOrderId(asset, order.id));
      if (remote.id) {
        await prisma.order.update({ where: { id: order.id }, data: { brokerOrderId: remote.id } });
        continue;
      }
    } catch (error) {
      if (!missingBrokerOrder(error)) {
        await logEvent(accountId, "BROKER", error instanceof Error ? error.message : "Could not recover an entry.", "warn");
        continue;
      }
    }
    await releaseWorkingEntry(order, "UNSENT");
    await logEvent(accountId, "BROKER", `Released cash for an unsent ${order.symbol} entry.`, "warn");
  }
}

async function reconcileAlpaca(accountId: string, now: Date, symbols: readonly string[]) {
  await recoverUnsentEntries(accountId, symbols, now);
  const entries = await prisma.order.findMany({
    where: { accountId, status: "WORKING", purpose: "ENTRY", brokerOrderId: { not: null }, symbol: { in: [...symbols] } },
  });
  for (const order of entries) {
    if (!order.brokerOrderId || order.limitPrice == null || order.stopPrice == null) continue;
    const remote = await getPaperOrder(order.brokerOrderId);
    const asset = assetBySymbol(order.symbol);
    if (remote.status === "filled") {
      const fill = roundPrice(Number(remote.filled_avg_price ?? order.limitPrice));
      const stopLeg = remote.legs?.find((leg) => leg.type === "stop" || leg.stop_price);
      const targetLeg = remote.legs?.find((leg) => leg.type === "limit" && leg.side === "sell");
      const stop = roundPrice(Number(stopLeg?.stop_price ?? order.stopPrice));
      const target = roundPrice(Number(targetLeg?.limit_price ?? fill * (1 + BROKER_CEILING_PCT)));
      const quantity = Number(remote.filled_qty ?? order.quantity);
      const reserved = notionalCents(order.quantity, order.limitPrice);
      const paid = notionalCents(quantity, fill);
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
            setup: asset?.setup ?? MOMENTUM_SETUP,
            strategy: asset?.strategyId ?? STRATEGY_ID,
            origin: "ENGINE",
            openedAt: now,
          },
        });
        await tx.order.update({
          where: { id: order.id },
          data: { status: "FILLED", fillPrice: fill, filledAt: now, tradeId: trade.id, quantity },
        });
        if (reserved !== paid) {
          await tx.account.update({
            where: { id: accountId },
            data: { cashCents: { increment: reserved - paid } },
          });
        }
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
            message: `Alpaca paper filled ${formatQty(quantity)} ${order.symbol} at ${fill.toFixed(2)}.`,
          },
        });
      });
    } else if (CLOSED_ORDER.has(remote.status)) {
      await releaseWorkingEntry(order, remote.status);
      await logEvent(accountId, "BROKER", `Alpaca paper entry ${remote.status}.`, "warn");
    }
  }

  const legs = await prisma.order.findMany({
    where: {
      accountId,
      status: "WORKING",
      purpose: { in: ["STOP", "TARGET"] },
      brokerOrderId: { not: null },
      symbol: { in: [...symbols] },
    },
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
    await closeTrade(trade, fill, leg.purpose, now, { recordExitOrder: false });
  }

  const open = await prisma.trade.findMany({
    where: { accountId, status: "OPEN", origin: "ENGINE", symbol: { in: [...symbols] } },
  });
  const clock = sessionClock(now);
  for (const trade of open) {
    if (isSessionExitSetup(trade.setup)) continue;
    const bars = await prisma.marketBar.findMany({
      where: { accountId, symbol: trade.symbol, timeframe: "1m", ts: { gte: new Date(`${clock.dateKey}T00:00:00Z`) } },
      orderBy: { ts: "asc" },
    });
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
    await logEvent(accountId, "STOP", `Stop tightened to ${stop.toFixed(2)} on ${formatQty(trade.quantity)} ${trade.symbol}.`);
  }
}

async function ensureCryptoStops(accountId: string) {
  const trades = await prisma.trade.findMany({
    where: { accountId, status: "OPEN", origin: "ENGINE", symbol: { in: [...CRYPTO_SYMBOLS] } },
  });
  for (const trade of trades) {
    const existing = await prisma.order.findFirst({
      where: { tradeId: trade.id, purpose: "STOP", status: "WORKING" },
    });
    if (existing) continue;
    try {
      const placed = await placePaperCryptoStop({
        symbol: trade.symbol,
        quantity: trade.quantity,
        stopPrice: trade.stopPrice,
        clientOrderId: `fonzo-stop-${trade.id}`.slice(0, 48),
      });
      await prisma.order.create({
        data: {
          accountId,
          tradeId: trade.id,
          symbol: trade.symbol,
          side: "SELL",
          type: "STOP",
          purpose: "STOP",
          quantity: trade.quantity,
          stopPrice: trade.stopPrice,
          status: "WORKING",
          brokerOrderId: placed.id,
        },
      });
      await logEvent(accountId, "STOP", `Stop working at ${trade.stopPrice.toFixed(2)} on ${formatQty(trade.quantity)} ${trade.symbol}.`);
    } catch (error) {
      await logEvent(accountId, "BROKER", error instanceof Error ? error.message : "Crypto stop was not accepted.", "warn");
    }
  }
}

export async function alignAlpaca(accountId: string, now = new Date()) {
  await reconcileAlpaca(accountId, now, [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS]);
  await syncAlpacaPaper(accountId, now);
}

async function todayBars(accountId: string, symbol: string, dateKey: string, market: "nyse" | "crypto") {
  const stored = await prisma.marketBar.findMany({
    where: { accountId, symbol, timeframe: "1m" },
    orderBy: { ts: "asc" },
  });
  return stored
    .filter((bar) => {
      if (!isStrategyBar(bar.timeframe)) return false;
      const key = market === "crypto" ? bar.ts.toISOString().slice(0, 10) : etParts(bar.ts).dateKey;
      return key === dateKey;
    })
    .map((bar) => ({
      ts: bar.ts.getTime(),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
}

async function considerStock(
  account: Account,
  asset: Asset,
  equityCents: number,
  clock: SessionClock,
  now: Date,
  mark: number,
) {
  const session = await ensureSession(account.id, clock.dateKey, asset.symbol);
  const bars = await todayBars(account.id, asset.symbol, clock.dateKey, "nyse");
  const pendingEntry = await prisma.order.count({
    where: { accountId: account.id, status: "WORKING", purpose: "ENTRY", symbol: asset.symbol },
  });
  const open = await prisma.trade.count({
    where: { accountId: account.id, status: "OPEN", origin: "ENGINE", symbol: asset.symbol },
  });
  const daily = await prisma.marketBar.findMany({
    where: { accountId: account.id, symbol: asset.symbol, timeframe: "1d" },
    orderBy: { ts: "desc" },
    take: 12,
  });
  const prior = daily.find((bar) => etParts(bar.ts).dateKey < clock.dateKey);
  const context = {
    now,
    bars,
    priorClose: prior?.close ?? null,
    earlyClose: clock.earlyClose,
    hasOpenPosition: open > 0 || pendingEntry > 0,
    tradesTaken: session.tradesTaken,
    maxTrades: RISK_LIMITS.maxTradesPerDay,
  };
  const view = asset.symbol === "QQQ" ? evaluateQqqMomentum(context) : evaluateIntradayMomentum(context);
  await prisma.strategySession.update({
    where: { id: session.id },
    data: { orHigh: view.orHigh, orLow: view.orLow, vwap: view.vwap, standDown: view.standDown },
  });
  if (view.standDown && session.standDown !== view.standDown) {
    await logEvent(account.id, "STAND_DOWN", `${asset.symbol}: ${view.standDown}`);
  }
  if (!view.proposal) return;
  const freshSession = await prisma.strategySession.findUniqueOrThrow({ where: { id: session.id } });
  const freshAccount = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
  await executeProposal(freshAccount, freshSession, equityCents, clock, view.proposal, mark, now, [...STOCK_SYMBOLS]);
}

async function considerCrypto(account: Account, asset: Asset, equityCents: number, now: Date, mark: number) {
  const utc = utcParts(now);
  const session = await ensureSession(account.id, utc.dateKey, asset.symbol);
  const bars = await todayBars(account.id, asset.symbol, utc.dateKey, "crypto");
  const pendingEntry = await prisma.order.count({
    where: { accountId: account.id, status: "WORKING", purpose: "ENTRY", symbol: asset.symbol },
  });
  const open = await prisma.trade.count({
    where: { accountId: account.id, status: "OPEN", origin: "ENGINE", symbol: asset.symbol },
  });
  const view = evaluateCryptoMomentum({
    now,
    bars,
    symbol: asset.symbol as "BTC/USD" | "ETH/USD",
    strategy: asset.strategyId,
    hasOpenPosition: open > 0 || pendingEntry > 0,
    tradesTaken: session.tradesTaken,
    maxTrades: RISK_LIMITS.maxTradesPerDay,
  });
  await prisma.strategySession.update({
    where: { id: session.id },
    data: { standDown: view.standDown },
  });
  if (view.standDown && session.standDown !== view.standDown) {
    await logEvent(account.id, "STAND_DOWN", `${asset.symbol}: ${view.standDown}`);
  }
  if (!view.proposal) return;
  const freshSession = await prisma.strategySession.findUniqueOrThrow({ where: { id: session.id } });
  const freshAccount = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
  const paused = { ...freshAccount, agentPaused: freshAccount.fonzoPaused };
  await executeProposal(paused, freshSession, equityCents, sessionClock(now), view.proposal, mark, now, [...CRYPTO_SYMBOLS]);
}

async function saveSleeve(accountId: string, equityCents: number, peakEquityCents: number, haltReason: string | null, extra?: object) {
  await prisma.account.update({
    where: { id: accountId },
    data: { equityCents, peakEquityCents, haltReason, ...extra },
  });
}

export async function tick(now = new Date()): Promise<{ ok: true; beat: Heartbeat } | { ok: false; reason: string }> {
  let account = await prisma.account.findFirst();
  if (!account) return { ok: false, reason: "No account" };
  const clock = sessionClock(now);
  const hot = ["preopen", "opening_range", "entry", "manage", "flatten"].includes(clock.phase);
  try {
    await refreshAssets(account.id, STOCK_ASSETS, hot, now, "stock");
  } catch (error) {
    await logEvent(account.id, "MARKET", error instanceof Error ? error.message : "Market data failed", "warn");
  }
  if (alpacaPaperConfigured()) {
    try {
      await reconcileAlpaca(account.id, now, STOCK_SYMBOLS);
      await syncAlpacaPaper(account.id, now);
      account = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    } catch (error) {
      await logEvent(account.id, "BROKER", error instanceof Error ? error.message : "Alpaca paper sync failed.", "warn");
    }
  }

  let book = await loadBook(account.id);
  let equityCents = book.equityCents;
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

  haltReason = haltReasonForState({ equityCents, peakEquityCents, dayStartEquityCents, weekStartEquityCents });
  await saveSleeve(account.id, equityCents, peakEquityCents, haltReason, {
    dayStartEquityCents,
    dayStartDate,
    weekStartEquityCents,
    weekStartDate,
  });

  if (clock.tradingDay) {
    if (account.mode !== "ALPACA_PAPER") await manageOpenTrades(account.id, now, STOCK_SYMBOLS);
    if (haltReason || clock.flattenDue) {
      const accountId = account.id;
      const sessions = await Promise.all(STOCK_SYMBOLS.map((symbol) => ensureSession(accountId, clock.dateKey, symbol)));
      if (sessions.some((session) => !session.flattened) || haltReason) {
        const closed = await flattenAgentTrades(account.id, now, haltReason ? "HALT" : "FLATTEN", { symbols: [...STOCK_SYMBOLS] });
        if (closed.length > 0) {
          const names = closed.join(" and ");
          await logEvent(account.id, "FLATTEN", haltReason ?? `Cash close. ${names} position sold.`);
        }
        const remaining = await prisma.trade.count({
          where: { accountId: account.id, status: "OPEN", origin: "ENGINE", symbol: { in: [...STOCK_SYMBOLS] } },
        });
        if (remaining === 0) {
          for (const session of sessions) {
            await prisma.strategySession.update({ where: { id: session.id }, data: { flattened: clock.flattenDue } });
          }
        }
      }
    } else if (clock.minutes >= retiredFlattenMinute(clock.earlyClose)) {
      const closed = await flattenAgentTrades(account.id, now, "FLATTEN", {
        exceptSetup: MOMENTUM_SETUP,
        symbols: [...STOCK_SYMBOLS],
      });
      if (closed.length > 0) {
        await logEvent(account.id, "FLATTEN", `Retired playbook cutoff. Open ${closed.join(" and ")} position closed.`);
      }
    }
  }

  book = await loadBook(account.id);
  equityCents = book.equityCents;
  account = book.account;
  if (clock.entryWindowOpen && !account.agentPaused && !haltReason) {
    for (const asset of STOCK_ASSETS) {
      const mark = book.marks[asset.symbol];
      if (mark == null) continue;
      const fresh = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
      const freshBook = await loadBook(account.id);
      await considerStock(fresh, asset, freshBook.equityCents, clock, now, mark);
    }
  }

  const finalBook = await loadBook(account.id);
  for (const asset of STOCK_ASSETS) {
    const mark = finalBook.marks[asset.symbol];
    if (mark == null) continue;
    await prisma.holding.updateMany({
      where: { accountId: account.id, symbol: asset.symbol },
      data: { marketPrice: mark },
    });
  }
  const finalEquity = finalBook.equityCents;
  await prisma.account.update({
    where: { id: account.id },
    data: { equityCents: finalEquity, peakEquityCents: Math.max(peakEquityCents, finalEquity) },
  });
  await snapshot(account.id, finalEquity, finalBook.account.cashCents, finalBook.marks.SPY ?? null, now);

  const beat: Heartbeat = {
    at: now.toISOString(),
    phase: clock.phase,
    label: clock.label,
    spy: finalBook.marks.SPY ?? null,
    qqq: finalBook.marks.QQQ ?? null,
    paused: account.agentPaused,
    haltReason,
    mode: account.mode,
  };
  writeJson(HEARTBEAT_PATH, beat);
  if (now.getTime() - lastHeartbeatEvent > 10 * 60_000) {
    lastHeartbeatEvent = now.getTime();
    const spy = beat.spy?.toFixed(2) ?? "—";
    const qqq = beat.qqq?.toFixed(2) ?? "—";
    await logEvent(account.id, "HEARTBEAT", `${clock.label}. SPY ${spy}. QQQ ${qqq}.`);
  }
  return { ok: true, beat };
}

export async function tickFonzo(now = new Date()): Promise<{ ok: true; beat: FonzoHeartbeat } | { ok: false; reason: string }> {
  let account = await prisma.account.findFirst();
  if (!account) return { ok: false, reason: "No account" };
  const clock = cryptoSessionClock(now);
  const minutes = utcParts(now).minutes;
  const hot = minutes >= 23 * 60 + 25 || minutes < 40;
  try {
    await refreshAssets(account.id, CRYPTO_ASSETS, hot, now, "crypto");
  } catch (error) {
    await logEvent(account.id, "MARKET", error instanceof Error ? error.message : "Crypto quotes failed", "warn");
  }
  if (alpacaPaperConfigured()) {
    try {
      await reconcileAlpaca(account.id, now, CRYPTO_SYMBOLS);
      await ensureCryptoStops(account.id);
      await syncAlpacaPaper(account.id, now);
      account = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    } catch (error) {
      await logEvent(account.id, "BROKER", error instanceof Error ? error.message : "Alpaca paper sync failed.", "warn");
    }
  }

  const book = await loadBook(account.id);
  let equityCents = book.equityCents;
  const peakEquityCents = Math.max(account.peakEquityCents, equityCents);
  const haltReason = haltReasonForState({
    equityCents,
    peakEquityCents,
    dayStartEquityCents: account.dayStartEquityCents,
    weekStartEquityCents: account.weekStartEquityCents,
  });
  await saveSleeve(account.id, equityCents, peakEquityCents, haltReason);

  if (account.mode !== "ALPACA_PAPER") await manageOpenTrades(account.id, now, CRYPTO_SYMBOLS);
  if (haltReason || clock.flattenDue) {
    const dateKey = utcParts(now).dateKey;
    const accountId = account.id;
    const sessions = await Promise.all(CRYPTO_SYMBOLS.map((symbol) => ensureSession(accountId, dateKey, symbol)));
    if (sessions.some((session) => !session.flattened) || haltReason) {
      const closed = await flattenAgentTrades(account.id, now, haltReason ? "HALT" : "FLATTEN", { symbols: [...CRYPTO_SYMBOLS] });
      if (closed.length > 0) {
        await logEvent(account.id, "FLATTEN", haltReason ?? `Session close. ${closed.join(" and ")} position sold.`);
      }
      const remaining = await prisma.trade.count({
        where: { accountId: account.id, status: "OPEN", origin: "ENGINE", symbol: { in: [...CRYPTO_SYMBOLS] } },
      });
      if (remaining === 0) {
        for (const session of sessions) {
          await prisma.strategySession.update({ where: { id: session.id }, data: { flattened: clock.flattenDue } });
        }
      }
    }
  }

  account = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
  if (clock.entryWindowOpen && !account.fonzoPaused && !haltReason) {
    for (const asset of CRYPTO_ASSETS) {
      const freshBook = await loadBook(account.id);
      const mark = freshBook.marks[asset.symbol];
      if (mark == null) continue;
      const fresh = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
      await considerCrypto(fresh, asset, freshBook.equityCents, now, mark);
    }
  }

  const finalBook = await loadBook(account.id);
  for (const asset of CRYPTO_ASSETS) {
    const mark = finalBook.marks[asset.symbol];
    if (mark == null) continue;
    await prisma.holding.updateMany({
      where: { accountId: account.id, symbol: asset.symbol },
      data: { marketPrice: mark },
    });
  }
  equityCents = finalBook.equityCents;
  await prisma.account.update({
    where: { id: account.id },
    data: { equityCents, peakEquityCents: Math.max(peakEquityCents, equityCents) },
  });

  const beat: FonzoHeartbeat = {
    at: now.toISOString(),
    phase: clock.phase,
    label: clock.label,
    btc: finalBook.marks["BTC/USD"] ?? null,
    eth: finalBook.marks["ETH/USD"] ?? null,
    paused: account.fonzoPaused,
    haltReason,
    mode: account.mode,
  };
  writeJson(FONZO_HEARTBEAT_PATH, beat);
  if (now.getTime() - lastFonzoHeartbeatEvent > 10 * 60_000) {
    lastFonzoHeartbeatEvent = now.getTime();
    const btc = beat.btc?.toFixed(2) ?? "—";
    const eth = beat.eth?.toFixed(2) ?? "—";
    await logEvent(account.id, "HEARTBEAT", `${clock.label}. BTC ${btc}. ETH ${eth}.`);
  }
  return { ok: true, beat };
}
