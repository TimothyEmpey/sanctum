import { etParts, roundPrice } from "@/lib/market/time";
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

export type TrendContext = {
  now: Date;
  bars: Bar[];
  hasOpenPosition: boolean;
  tradesTaken: number;
  consecutiveLosses: number;
  maxTrades?: number;
};

export type TrendProposal = {
  symbol: "SPY";
  side: Side;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  setup: "TREND_PULLBACK";
  strategy: string;
  reason: string;
  signalBarTs: number;
};

export type TrendSnapshot = {
  ready: boolean;
  orHigh: number | null;
  orLow: number | null;
  orWidth: number | null;
  vwap: number | null;
  vwapSlope: number | null;
  standDown: string | null;
  proposal: TrendProposal | null;
  note: string;
};

/**
 * Minimum stop under the entry. A recent SPY day travels about 0.5% to 0.9%,
 * so a 1% stop and a 2% target sit outside a normal session. 0.25% is about
 * $2 on a $780 print, wider than one noisy 5-minute bar and inside the day.
 */
const STOP_PCT = 0.0025;
const TARGET_R = 1.5;
const LIMIT_OFFSET = 0.02;
/** A dip within 0.5% of VWAP still counts. The old 0.04% tag blocked ordinary days. */
const VWAP_BAND = 0.005;

function aggregate(list: Bar[]): Bar {
  const ordered = [...list].sort((a, b) => a.ts - b.ts);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  return {
    ts: last.ts,
    open: first.open,
    high: Math.max(...ordered.map((bar) => bar.high)),
    low: Math.min(...ordered.map((bar) => bar.low)),
    close: last.close,
    volume: ordered.reduce((sum, bar) => sum + bar.volume, 0),
  };
}

function fiveMinute(bars: Bar[], dateKey: string, nowMinutes: number) {
  const groups = new Map<number, Bar[]>();
  for (const bar of bars) {
    const z = etParts(new Date(bar.ts));
    if (z.dateKey !== dateKey || z.minutes < 9 * 60 + 30 || z.minutes >= 16 * 60) continue;
    const start = z.minutes - (z.minutes % 5);
    if (nowMinutes < start + 5) continue;
    const list = groups.get(start) ?? [];
    list.push(bar);
    groups.set(start, list);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => aggregate(list));
}

function vwapAt(bars: Bar[], dateKey: string, throughMinutes: number) {
  let weighted = 0;
  let volume = 0;
  for (const bar of bars) {
    const z = etParts(new Date(bar.ts));
    if (z.dateKey !== dateKey || z.minutes < 9 * 60 + 30 || z.minutes > throughMinutes || bar.volume <= 0) continue;
    const typical = (bar.high + bar.low + bar.close) / 3;
    weighted += typical * bar.volume;
    volume += bar.volume;
  }
  if (volume <= 0) return null;
  return weighted / volume;
}

function empty(note: string, extra: Partial<TrendSnapshot> = {}): TrendSnapshot {
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

/**
 * Long-only trend pullback. One SPY buy a day while VWAP is rising.
 * The stop is at least 0.25% under the entry, or beyond the dip if that is
 * farther. The target is 1.5 times the stop distance, about 0.4% when the
 * stop is at the minimum. A wide dip is not rejected. The risk engine buys
 * fewer shares instead.
 */
export function evaluateTrendPullback(context: TrendContext): TrendSnapshot {
  const z = etParts(context.now);
  const maxTrades = context.maxTrades ?? 1;
  const base = {
    vwap: vwapAt(context.bars, z.dateKey, z.minutes),
    vwapSlope: null as number | null,
  };
  if (context.hasOpenPosition) return { ...empty("An SPY position is already open.", base) };
  if (context.tradesTaken >= maxTrades) return { ...empty("Daily trade cap reached.", base) };

  const bars = fiveMinute(context.bars, z.dateKey, z.minutes);
  const latest = bars.at(-1);
  const previous = bars.at(-2);
  if (!latest || !previous) return { ...empty("Waiting for two completed 5-minute bars.", base) };

  const priorVwap = vwapAt(context.bars, z.dateKey, z.minutes - 5);
  const vwap = base.vwap;
  const vwapSlope = vwap != null && priorVwap != null ? vwap - priorVwap : null;
  const view = { vwap, vwapSlope };
  if (vwap == null || vwapSlope == null || vwapSlope <= 0) {
    return { ...empty("VWAP is not rising.", view) };
  }
  if (latest.close <= vwap) return { ...empty("Price is not above VWAP.", view) };

  const dipped = previous.close > vwap && (latest.low < previous.close || latest.low <= vwap * (1 + VWAP_BAND));
  const reclaimed = latest.close > latest.open && latest.close > previous.close;
  if (!dipped || !reclaimed) {
    return { ...empty("No trend pullback on the latest 5-minute bar.", view) };
  }

  const entry = roundPrice(latest.close + LIMIT_OFFSET);
  const minimumStop = roundPrice(entry * (1 - STOP_PCT));
  const beyondDip = roundPrice(latest.low - 0.01);
  const stop = roundPrice(Math.min(minimumStop, beyondDip));
  const stopDistance = roundPrice(entry - stop);
  if (!(stop < entry) || stopDistance <= 0) return { ...empty("Stop is not below the entry.", view) };

  return {
    ready: true,
    orHigh: null,
    orLow: null,
    orWidth: null,
    vwap,
    vwapSlope,
    standDown: null,
    note: "Trend pullback. Target is 1.5 times the stop distance.",
    proposal: {
      symbol: "SPY",
      side: "LONG",
      entryPrice: entry,
      stopPrice: stop,
      targetPrice: roundPrice(entry + stopDistance * TARGET_R),
      setup: "TREND_PULLBACK",
      strategy: STRATEGY_ID,
      reason: "5-minute dip while price holds a rising VWAP. Stop is at least 0.25% under the entry and the target is 1.5 times that risk.",
      signalBarTs: latest.ts,
    },
  };
}
