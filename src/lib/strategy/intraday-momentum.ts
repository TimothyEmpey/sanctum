import { LAST_HALF_GRACE_MINUTES, lastHalfHourStart } from "@/lib/market/calendar";
import { etInstant, etParts, roundPrice } from "@/lib/market/time";
import { STRATEGY_ID } from "@/lib/risk/constants";
import type { Side } from "@/lib/risk/types";

export type Bar = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * Gao, Han, Li, and Zhou, "Market intraday momentum," Journal of Financial
 * Economics 129 (2018). Their timing rule η(r1) is long the last half-hour
 * when the return from the previous close to 10:00 ET is positive, and short
 * otherwise. The position is closed at the cash close. This desk is long-only,
 * so a non-positive signal is a flat day.
 *
 * The paper has no stop and no profit target. This desk will not enter without
 * a stop. Two percent is the account's per-trade risk budget, so the risk
 * engine can still buy with the cash on hand, and a normal last half-hour does
 * not reach it. The bracket also needs a limit above the entry. That ceiling
 * is not the exit. The exit is the cash close.
 */
export const MOMENTUM_SETUP = "INTRADAY_MOMENTUM";
export const DISASTER_STOP_PCT = 0.02;
export const BROKER_CEILING_PCT = 0.05;
const LIMIT_OFFSET = 0.02;

export type MomentumContext = {
  now: Date;
  bars: Bar[];
  priorClose: number | null;
  earlyClose: boolean;
  hasOpenPosition: boolean;
  tradesTaken: number;
  maxTrades?: number;
};

export type MomentumAsset = {
  symbol: "SPY" | "QQQ";
  strategy: string;
  setup: string;
};

const SPY_ASSET: MomentumAsset = {
  symbol: "SPY",
  strategy: STRATEGY_ID,
  setup: MOMENTUM_SETUP,
};

export type MomentumProposal = {
  symbol: "SPY" | "QQQ";
  side: Side;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  setup: string;
  strategy: string;
  reason: string;
  signalBarTs: number;
};

export type MomentumSnapshot = {
  ready: boolean;
  orHigh: number | null;
  orLow: number | null;
  orWidth: number | null;
  vwap: number | null;
  vwapSlope: number | null;
  standDown: string | null;
  proposal: MomentumProposal | null;
  note: string;
};

function empty(note: string, extra: Partial<MomentumSnapshot> = {}): MomentumSnapshot {
  return {
    ready: false,
    orHigh: null,
    orLow: null,
    orWidth: null,
    vwap: null,
    vwapSlope: null,
    standDown: null,
    proposal: null,
    note,
    ...extra,
  };
}

/** Price at 10:00 ET: close of the 9:59 bar, which ends at 10:00. */
export function priceAtTen(bars: Bar[], dateKey: string, nowMinutes: number) {
  if (nowMinutes < 10 * 60) return null;
  let fromPriorMinute: number | null = null;
  let fromBoundaryOpen: number | null = null;
  for (const bar of bars) {
    const z = etParts(new Date(bar.ts));
    if (z.dateKey !== dateKey) continue;
    if (z.minutes === 10 * 60 - 1) fromPriorMinute = bar.close;
    if (z.minutes === 10 * 60 && fromBoundaryOpen == null) fromBoundaryOpen = bar.open;
  }
  return fromPriorMinute ?? fromBoundaryOpen;
}

function latestPrint(bars: Bar[], dateKey: string, nowMinutes: number) {
  let best: Bar | null = null;
  for (const bar of bars) {
    const z = etParts(new Date(bar.ts));
    if (z.dateKey !== dateKey || z.minutes < 9 * 60 + 30 || z.minutes > nowMinutes) continue;
    if (!best || bar.ts > best.ts) best = bar;
  }
  return best?.close ?? null;
}

function entryClock(earlyClose: boolean) {
  const start = lastHalfHourStart(earlyClose);
  const hour = Math.floor(start / 60);
  const minute = start % 60;
  const label = earlyClose ? "12:30 PM ET" : "3:30 PM ET";
  return { start, hour, minute, label };
}

export function evaluateIntradayMomentum(context: MomentumContext, asset: MomentumAsset = SPY_ASSET): MomentumSnapshot {
  const z = etParts(context.now);
  const maxTrades = context.maxTrades ?? 1;
  const clock = entryClock(context.earlyClose);
  const inWindow = z.minutes >= clock.start && z.minutes < clock.start + LAST_HALF_GRACE_MINUTES;
  const ten = priceAtTen(context.bars, z.dateKey, z.minutes);
  const prior = context.priorClose != null && context.priorClose > 0 ? context.priorClose : null;
  const signalUp = ten != null && prior != null && roundPrice(ten) > roundPrice(prior);

  if (z.minutes < clock.start) {
    if (ten != null && prior != null && !signalUp) {
      return empty("First half-hour is not above the previous close.", {
        standDown: "First half-hour is not above the previous close. The published rule would short. This book stays flat.",
      });
    }
    return empty(
      signalUp
        ? `First half-hour is up. The buy is at ${clock.label}.`
        : "Waiting for the 10:00 ET price and the previous close.",
    );
  }

  if (!inWindow) {
    return empty("The last-half-hour entry has passed.", {
      standDown: signalUp ? `The ${clock.label} entry has passed.` : null,
    });
  }

  if (context.hasOpenPosition) return empty(`A ${asset.symbol} position is already open.`);
  if (context.tradesTaken >= maxTrades) return empty("Daily trade cap reached.");
  if (ten == null || prior == null) return empty("The 10:00 ET price or the previous close is missing.");
  if (!signalUp) {
    return empty("First half-hour is not above the previous close.", {
      standDown: "First half-hour is not above the previous close. The published rule would short. This book stays flat.",
    });
  }

  const latest = latestPrint(context.bars, z.dateKey, z.minutes);
  if (latest == null) return empty(`No ${asset.symbol} price for the entry.`);
  const entry = roundPrice(latest + LIMIT_OFFSET);
  const stop = roundPrice(entry * (1 - DISASTER_STOP_PCT));
  const target = roundPrice(entry * (1 + BROKER_CEILING_PCT));
  if (!(stop < entry) || !(target > entry)) return empty("Stop is not below the entry.");

  return {
    ready: true,
    orHigh: null,
    orLow: null,
    orWidth: null,
    vwap: null,
    vwapSlope: null,
    standDown: null,
    note: `Last half-hour long. Sell at the cash close. The ${clock.label} entry is the published open.`,
    proposal: {
      symbol: asset.symbol,
      side: "LONG",
      entryPrice: entry,
      stopPrice: stop,
      targetPrice: target,
      setup: asset.setup,
      strategy: asset.strategy,
      reason:
        "First half-hour return, previous close to 10:00 ET, is positive. Buy the last half-hour and sell at the cash close. The stop is 2% under the entry.",
      signalBarTs: etInstant(z.dateKey, clock.hour, clock.minute).getTime(),
    },
  };
}
