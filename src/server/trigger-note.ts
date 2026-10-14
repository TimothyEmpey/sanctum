import { normalizeSymbol, type Asset } from "@/lib/assets";
import { cryptoSessionClock } from "@/lib/market/crypto-clock";
import { sessionClock } from "@/lib/market/calendar";
import { etInstant, etParts } from "@/lib/market/time";
import type { Bar } from "@/lib/strategy/intraday-momentum";
import { blockingReason, describeAssetTrigger, heartbeatFresh } from "@/lib/strategy/trigger-caveat";
import { prisma } from "@/server/db";

function proposalSymbol(proposal: unknown) {
  if (!proposal || typeof proposal !== "object" || !("symbol" in proposal)) return null;
  const symbol = (proposal as { symbol?: unknown }).symbol;
  return typeof symbol === "string" ? normalizeSymbol(symbol) : null;
}

function priorClose(daily: { ts: number; close: number }[], dateKey: string) {
  let best: { ts: number; close: number } | null = null;
  for (const bar of daily) {
    if (etParts(new Date(bar.ts)).dateKey >= dateKey) continue;
    if (!best || bar.ts > best.ts) best = bar;
  }
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

/**
 * The charts keep the latest 500 minutes. Crypto's signal is 00:00–00:29 UTC,
 * which is outside that window later in the day, so the caveat reads these bars itself.
 */
export async function loadSignalMinutes(accountId: string, asset: Asset, now: Date): Promise<Bar[]> {
  const stock = sessionClock(now);
  const crypto = cryptoSessionClock(now);
  const range =
    asset.market === "crypto"
      ? { from: new Date(`${crypto.dateKey}T00:00:00.000Z`), to: new Date(`${crypto.dateKey}T00:29:00.000Z`) }
      : stock.tradingDay
        ? { from: etInstant(stock.dateKey, 9, 59), to: etInstant(stock.dateKey, 10, 0) }
        : null;
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
  daily: { ts: number; close: number }[];
  traded: boolean;
  paused: boolean;
  haltReason: string | null;
  heartbeatAt: string | null | undefined;
  riskDecisions: { approved: boolean; proposal: unknown; reasons: string[]; createdAt: Date }[];
}) {
  const stock = sessionClock(input.now);
  const crypto = cryptoSessionClock(input.now);
  const dateKey = input.asset.market === "crypto" ? crypto.dateKey : stock.dateKey;
  const quiet =
    input.asset.market === "crypto" ? crypto.phase === "signal" || crypto.phase === "wait" : stock.phase === "closed" || stock.phase === "idle";
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
