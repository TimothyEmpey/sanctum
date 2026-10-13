import { utcParts, CRYPTO_ENTRY_START, CRYPTO_SIGNAL_END, cryptoSessionClock } from "@/lib/market/crypto-clock";
import { roundPrice } from "@/lib/market/time";
import { DISASTER_STOP_PCT, BROKER_CEILING_PCT, type Bar } from "@/lib/strategy/intraday-momentum";
import type { Side } from "@/lib/risk/types";

export const CRYPTO_SETUP = "CRYPTO_LAST_HALF";
const LIMIT_OFFSET = 0.02;

export type CryptoProposal = {
  symbol: "BTC/USD" | "ETH/USD";
  side: Side;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  setup: typeof CRYPTO_SETUP;
  strategy: string;
  reason: string;
  signalBarTs: number;
  market: "crypto";
};

export type CryptoSnapshot = {
  ready: boolean;
  standDown: string | null;
  proposal: CryptoProposal | null;
  note: string;
};

function empty(note: string, standDown: string | null = null): CryptoSnapshot {
  return { ready: false, standDown, proposal: null, note };
}

/** First-half return: 00:00 UTC open to the 00:29 close. */
export function firstHalfReturn(bars: Bar[], dateKey: string, nowMinutes: number) {
  if (nowMinutes < CRYPTO_SIGNAL_END) return null;
  let start: number | null = null;
  let end: number | null = null;
  for (const bar of bars) {
    const stamp = new Date(bar.ts);
    if (stamp.toISOString().slice(0, 10) !== dateKey) continue;
    const minutes = stamp.getUTCHours() * 60 + stamp.getUTCMinutes();
    if (minutes === 0 && start == null) start = bar.open;
    if (minutes === CRYPTO_SIGNAL_END - 1) end = bar.close;
  }
  if (start == null || end == null || !(start > 0)) return null;
  return { start, end, up: roundPrice(end) > roundPrice(start) };
}

function latestPrint(bars: Bar[], dateKey: string, nowMinutes: number) {
  let best: Bar | null = null;
  for (const bar of bars) {
    const stamp = new Date(bar.ts);
    if (stamp.toISOString().slice(0, 10) !== dateKey) continue;
    const minutes = stamp.getUTCHours() * 60 + stamp.getUTCMinutes();
    if (minutes > nowMinutes) continue;
    if (!best || bar.ts > best.ts) best = bar;
  }
  return best?.close ?? null;
}

export function evaluateCryptoMomentum(context: {
  now: Date;
  bars: Bar[];
  symbol: "BTC/USD" | "ETH/USD";
  strategy: string;
  hasOpenPosition: boolean;
  tradesTaken: number;
  maxTrades?: number;
}): CryptoSnapshot {
  const z = utcParts(context.now);
  const clock = cryptoSessionClock(context.now);
  const signal = firstHalfReturn(context.bars, z.dateKey, z.minutes);
  const maxTrades = context.maxTrades ?? 1;
  const flat = "First half-hour is not up. The published short stays off. This book stays flat.";

  if (z.minutes < CRYPTO_ENTRY_START) {
    if (signal && !signal.up) return empty("First half-hour is not up.", flat);
    return empty(signal?.up ? "First half-hour is up. The buy is at 23:30 UTC." : "Waiting for the 00:30 UTC price.");
  }

  if (!clock.entryWindowOpen) {
    return empty("The last-half-hour entry has passed.", signal?.up ? "The 23:30 UTC entry has passed." : null);
  }

  if (context.hasOpenPosition) return empty(`A ${context.symbol} position is already open.`);
  if (context.tradesTaken >= maxTrades) return empty("Daily trade cap reached.");
  if (!signal) return empty("The first half-hour prices are missing.");
  if (!signal.up) return empty("First half-hour is not up.", flat);

  const latest = latestPrint(context.bars, z.dateKey, z.minutes);
  if (latest == null) return empty(`No ${context.symbol} price for the entry.`);
  const entry = roundPrice(latest + LIMIT_OFFSET);
  const stop = roundPrice(entry * (1 - DISASTER_STOP_PCT));
  const target = roundPrice(entry * (1 + BROKER_CEILING_PCT));
  if (!(stop < entry) || !(target > entry)) return empty("Stop is not below the entry.");
  const start = new Date(`${z.dateKey}T23:30:00.000Z`);

  return {
    ready: true,
    standDown: null,
    note: "Last half-hour long. Sell at 24:00 UTC.",
    proposal: {
      symbol: context.symbol,
      side: "LONG",
      entryPrice: entry,
      stopPrice: stop,
      targetPrice: target,
      setup: CRYPTO_SETUP,
      strategy: context.strategy,
      reason:
        "First half-hour return, 00:00 UTC to 00:30 UTC, is positive. Buy the last half-hour and sell at 24:00 UTC. The stop is 2% under the entry.",
      signalBarTs: start.getTime(),
      market: "crypto",
    },
  };
}
