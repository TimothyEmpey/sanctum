import { normalizeSymbol, type Asset } from "@/lib/assets";
import { cryptoSessionClock } from "@/lib/market/crypto-clock";
import { previousBusinessDays, sessionClock } from "@/lib/market/calendar";
import { etInstant, etParts } from "@/lib/market/time";
import type { Bar } from "@/lib/strategy/intraday-momentum";
import { evaluateCryptoDiscount } from "@/lib/strategy/crypto-discount";
import { evaluateNqSweep } from "@/lib/strategy/nq-sweep";
import { evaluateSpyStructure } from "@/lib/strategy/spy-structure";
import { blockingReason, describeAssetTrigger, describeNqTrigger, describeSequenceTrigger, describeSpyTrigger, heartbeatFresh } from "@/lib/strategy/trigger-caveat";
import { prisma } from "@/server/db";

function proposalSymbol(proposal: unknown) {
  if (!proposal || typeof proposal !== "object" || !("symbol" in proposal)) return null;
  const symbol = (proposal as { symbol?: unknown }).symbol;
  return typeof symbol === "string" ? normalizeSymbol(symbol) : null;
}

function priorDay(daily: { ts: number; close: number; high?: number; low?: number }[], dateKey: string) {
  let best: { ts: number; close: number; high?: number; low?: number } | null = null;
  for (const bar of daily) {
    if (etParts(new Date(bar.ts)).dateKey >= dateKey) continue;
    if (!best || bar.ts > best.ts) best = bar;
  }
  return best;
}

function priorClose(daily: { ts: number; close: number; high?: number; low?: number }[], dateKey: string) {
  const best = priorDay(daily, dateKey);
  return best && best.close > 0 ? best.close : null;
}

export function sessionRiskReasons(
  decisions: { approved: boolean; proposal: unknown; reasons: string[]; createdAt: Date }[],
  symbol: string,
  dateKey: string,
  market: Asset["market"],
) {
  for (const decision of decisions) {
    const symbolOnProposal = proposalSymbol(decision.proposal);
    const matches = symbolOnProposal == null ? symbol === "SPY" : symbolOnProposal === symbol;
    if (!matches) continue;
    const key = market === "crypto" ? decision.createdAt.toISOString().slice(0, 10) : etParts(decision.createdAt).dateKey;
    if (key !== dateKey) continue;
    return decision.approved ? null : decision.reasons;
  }
  return null;
}

/** Regular-hours minutes for one ET session. The Nasdaq caveat needs the whole morning, not the 10:00 print. */
export async function loadDayMinutes(accountId: string, symbol: string, dateKey: string): Promise<Bar[]> {
  const rows = await prisma.marketBar.findMany({
    where: {
      accountId,
      symbol,
      timeframe: "1m",
      ts: { gte: etInstant(dateKey, 9, 30), lte: etInstant(dateKey, 16, 15) },
    },
    orderBy: { ts: "asc" },
  });
  return rows.map((bar) => ({
    ts: bar.ts.getTime(),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));
}

/** Today plus the previous session. SPY structure can use yesterday's swings. The signal still has to print today. */
export async function loadStructureMinutes(accountId: string, symbol: string, dateKey: string): Promise<Bar[]> {
  const prior = previousBusinessDays(dateKey, 1)[0];
  const [today, yesterday] = await Promise.all([
    loadDayMinutes(accountId, symbol, dateKey),
    prior ? loadDayMinutes(accountId, symbol, prior) : Promise.resolve([]),
  ]);
  return [...yesterday, ...today];
}

/** Hourly bars for the BTC and ETH range. The caveat reads the same bars the playbook reads. */
export async function loadStructureHours(accountId: string, symbol: string): Promise<Bar[]> {
  const rows = await prisma.marketBar.findMany({
    where: { accountId, symbol, timeframe: "1h" },
    orderBy: { ts: "asc" },
  });
  return rows.map((bar) => ({
    ts: bar.ts.getTime(),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));
}

export async function loadSignalMinutes(accountId: string, asset: Asset, now: Date): Promise<Bar[]> {
  const stock = sessionClock(now);
  if (asset.market === "crypto") return loadStructureHours(accountId, asset.symbol);
  const range = stock.tradingDay ? { from: etInstant(stock.dateKey, 9, 59), to: etInstant(stock.dateKey, 10, 0) } : null;
  if (!range) return [];
  const rows = await prisma.marketBar.findMany({
    where: { accountId, symbol: asset.symbol, timeframe: "1m", ts: { gte: range.from, lte: range.to } },
    orderBy: { ts: "asc" },
  });
  return rows.map((bar) => ({
    ts: bar.ts.getTime(),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));
}

export function assetTriggerCaveat(input: {
  asset: Asset;
  now: Date;
  minutes: Bar[];
  daily: { ts: number; close: number; high?: number; low?: number }[];
  esMinutes?: Bar[];
  traded: boolean;
  paused: boolean;
  haltReason: string | null;
  heartbeatAt: string | null | undefined;
  riskDecisions: { approved: boolean; proposal: unknown; reasons: string[]; createdAt: Date }[];
}) {
  const stock = sessionClock(input.now);
  const crypto = cryptoSessionClock(input.now);
  const dateKey = input.asset.market === "crypto" ? crypto.dateKey : stock.dateKey;
  const quiet = input.asset.market === "crypto" ? false : stock.phase === "closed" || stock.phase === "idle";
  const block =
    input.haltReason ??
    (input.paused ? (input.asset.desk === "fonzo" ? "Fonzo is paused." : "Uriel is paused.") : null) ??
    (heartbeatFresh(input.heartbeatAt, quiet) ? null : "Worker is offline.") ??
    blockingReason(sessionRiskReasons(input.riskDecisions, input.asset.symbol, dateKey, input.asset.market));
  if (input.asset.symbol === "NQ") {
    if (input.traded) return null;
    if (!stock.tradingDay) return "Cash market is closed.";
    const prior = priorDay(input.daily, dateKey);
    const view = evaluateNqSweep({
      now: input.now,
      bars: input.minutes,
      esBars: input.esMinutes ?? [],
      priorHigh: prior?.high ?? null,
      priorLow: prior?.low ?? null,
      hasOpenPosition: false,
      tradesTaken: 0,
    });
    return describeNqTrigger(view.state, block);
  }
  if (input.asset.symbol === "SPY") {
    if (input.traded) return null;
    if (!stock.tradingDay) return "Cash market is closed.";
    const prior = priorDay(input.daily, dateKey);
    const view = evaluateSpyStructure({
      now: input.now,
      bars: input.minutes,
      priorHigh: prior?.high ?? null,
      priorLow: prior?.low ?? null,
      hasOpenPosition: false,
      tradesTaken: 0,
    });
    return describeSpyTrigger(view.state, block);
  }
  if (input.asset.market === "crypto") {
    if (input.traded) return null;
    const view = evaluateCryptoDiscount({
      now: input.now,
      bars: input.minutes,
      symbol: input.asset.symbol as "BTC/USD" | "ETH/USD",
      strategy: input.asset.strategyId,
      hasOpenPosition: false,
      tradesTaken: 0,
    });
    return describeSequenceTrigger(view.state, block);
  }
  return describeAssetTrigger({
    market: input.asset.market,
    now: input.now,
    minutes: input.minutes,
    priorClose: input.asset.market === "nyse" ? priorClose(input.daily, dateKey) : null,
    traded: input.traded,
    paused: input.paused,
    workerName: input.asset.desk === "fonzo" ? "Fonzo" : "Uriel",
    haltReason: input.haltReason,
    workerFresh: heartbeatFresh(input.heartbeatAt, quiet),
    riskReason: blockingReason(sessionRiskReasons(input.riskDecisions, input.asset.symbol, dateKey, input.asset.market)),
  });
}
