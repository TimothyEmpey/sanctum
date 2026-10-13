import { etParts, roundPrice } from "@/lib/market/time";
import type { Side } from "@/lib/risk/types";

/** Retired playbook. The worker does not call this. */
const STRATEGY_ID = "spy-orb-2026";

export type Bar = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type OrbContext = {
  now: Date;
  bars: Bar[];
  hasOpenPosition: boolean;
  tradesTaken: number;
  consecutiveLosses: number;
  longStopped: boolean;
  maxTrades?: number;
};

export type OrbProposal = {
  symbol: "SPY";
  side: Side;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  setup: "ORB_LONG";
  strategy: string;
  reason: string;
  signalBarTs: number;
};

export type OrbSnapshot = {
  ready: boolean;
  orHigh: number | null;
  orLow: number | null;
  orWidth: number | null;
  vwap: number | null;
  vwapSlope: number | null;
  standDown: string | null;
  proposal: OrbProposal | null;
  note: string;
};

const MIN_WIDTH = 0.0006;
const MAX_WIDTH = 0.007;
const MIN_STOP = 0.05;
const MAX_STOP_PCT = 0.0065;
const VOLUME_MULTIPLE = 1.3;
const TARGET_R = 1.5;
const LIMIT_OFFSET = 0.02;

function rthBars(bars: Bar[], dateKey: string) {
  return bars
    .filter((bar) => {
      const z = etParts(new Date(bar.ts));
      return z.dateKey === dateKey && z.minutes >= 9 * 60 + 30 && z.minutes < 16 * 60;
    })
    .sort((a, b) => a.ts - b.ts);
}

function bucketStart(minutes: number) {
  return minutes - (minutes % 5);
}

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

function fiveMinute(bars: Bar[], fromMinute: number, nowMinutes: number) {
  const groups = new Map<number, Bar[]>();
  for (const bar of bars) {
    const minutes = etParts(new Date(bar.ts)).minutes;
    if (minutes < fromMinute) continue;
    const start = bucketStart(minutes);
    const list = groups.get(start) ?? [];
    list.push(bar);
    groups.set(start, list);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([start]) => nowMinutes >= start + 5)
    .map(([, list]) => aggregate(list));
}

function vwapOf(bars: Bar[]) {
  let weighted = 0;
  let volume = 0;
  for (const bar of bars) {
    const typical = (bar.high + bar.low + bar.close) / 3;
    weighted += typical * bar.volume;
    volume += bar.volume;
  }
  if (volume <= 0) return null;
  return weighted / volume;
}

function empty(note: string, extra: Partial<OrbSnapshot> = {}): OrbSnapshot {
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
 * 15-minute opening range breakout used by SPY desks in 2026:
 * a 5-minute close outside the 9:30–9:45 range, with volume at least
 * 1.3× the opening-range pace and price on the rising side of VWAP.
 * Shorts stay off. 2026 SPY breakout losses clustered on the short side,
 * and Robinhood's agent account currently places long equity orders.
 */
export function evaluateOrb(context: OrbContext): OrbSnapshot {
  const z = etParts(context.now);
  const today = rthBars(context.bars, z.dateKey);
  const opening = today.filter((bar) => {
    const minutes = etParts(new Date(bar.ts)).minutes;
    return minutes >= 9 * 60 + 30 && minutes < 9 * 60 + 45;
  });

  if (z.minutes < 9 * 60 + 50) {
    return empty("Opening range is still forming.");
  }
  if (opening.length < 10) {
    return empty("Not enough opening-range bars to trust the high and low.");
  }

  const orHigh = Math.max(...opening.map((bar) => bar.high));
  const orLow = Math.min(...opening.map((bar) => bar.low));
  const mid = (orHigh + orLow) / 2;
  const orWidth = mid > 0 ? (orHigh - orLow) / mid : 0;
  const vwap = vwapOf(today.filter((bar) => etParts(new Date(bar.ts)).minutes <= z.minutes));
  const priorCutoff = z.minutes - 5;
  const vwapPrev = vwapOf(
    today.filter((bar) => etParts(new Date(bar.ts)).minutes <= priorCutoff),
  );
  const vwapSlope = vwap != null && vwapPrev != null ? vwap - vwapPrev : null;

  const base = {
    ready: true,
    orHigh,
    orLow,
    orWidth,
    vwap,
    vwapSlope,
  };

  if (orWidth < MIN_WIDTH) {
    return { ...empty("Opening range is too narrow.", base), standDown: "Opening range is too narrow." };
  }
  if (orWidth > MAX_WIDTH) {
    return { ...empty("Opening range is too wide.", base), standDown: "Opening range is event-sized. Standing down." };
  }
  if (context.hasOpenPosition) {
    return { ...empty("SPY day-trade is already open.", base), proposal: null };
  }
  if (context.tradesTaken >= (context.maxTrades ?? 3)) {
    return { ...empty("Three trades already taken today.", base) };
  }
  if (context.consecutiveLosses >= 2) {
    return { ...empty("Two losses in a row. No revenge trade.", base) };
  }
  if (context.longStopped) {
    return { ...empty("Long breakout already stopped. No second attempt.", base) };
  }

  const signalBars = fiveMinute(today, 9 * 60 + 45, z.minutes);
  const latest = signalBars.at(-1);
  if (!latest) return { ...empty("Waiting for a completed 5-minute bar.", base) };

  // The latest cross, not the first one of the day. A close back through the
  // range and then above it again is a new breakout, up to the daily trade cap.
  let cross: Bar | null = null;
  for (let index = signalBars.length - 1; index >= 0; index -= 1) {
    const bar = signalBars[index];
    const previous = signalBars[index - 1];
    if (bar.close > orHigh && (previous == null || previous.close <= orHigh)) {
      cross = bar;
      break;
    }
  }
  if (!cross || latest.close <= orHigh) {
    return { ...empty("No fresh close above the opening range.", base) };
  }
  const crossAge = z.minutes - etParts(new Date(cross.ts)).minutes;
  if (crossAge > 10) {
    return { ...empty("The breakout is stale. Uriel does not chase it.", base) };
  }

  const orVolumes = orBucketVolumes(opening);
  const average = orVolumes.length
    ? orVolumes.reduce((sum, value) => sum + value, 0) / orVolumes.length
    : 0;
  if (!(average > 0) || cross.volume < average * VOLUME_MULTIPLE) {
    return { ...empty("Breakout volume is below 1.3× the opening range.", base) };
  }
  if (vwap == null || latest.close <= vwap || vwapSlope == null || vwapSlope <= 0) {
    return { ...empty("Price is not above a rising VWAP.", base) };
  }

  const entry = roundPrice(cross.close + LIMIT_OFFSET);
  const structural = roundPrice(Math.max(orLow, cross.low - 0.01));
  const stop = structural;
  const stopDistance = roundPrice(entry - stop);
  if (stopDistance < MIN_STOP) {
    return { ...empty("Natural stop is inside the spread.", base) };
  }
  if (stopDistance / entry > MAX_STOP_PCT) {
    return { ...empty("Stop distance is wider than 0.65% of price.", base) };
  }
  const target = roundPrice(entry + TARGET_R * (entry - stop));

  return {
    ...base,
    standDown: null,
    proposal: {
      symbol: "SPY",
      side: "LONG",
      entryPrice: entry,
      stopPrice: stop,
      targetPrice: target,
      setup: "ORB_LONG",
      strategy: STRATEGY_ID,
      reason: "5-minute close above the 15-minute opening range, confirmed by volume and a rising VWAP.",
      signalBarTs: cross.ts,
    },
    note: "Long opening-range breakout.",
  };
}

function orBucketVolumes(opening: Bar[]) {
  const groups = new Map<number, number>();
  for (const bar of opening) {
    const minutes = etParts(new Date(bar.ts)).minutes;
    const start = bucketStart(minutes);
    groups.set(start, (groups.get(start) ?? 0) + bar.volume);
  }
  return [...groups.values()];
}

export function unrealizedPnlCents(side: Side, entry: number, mark: number, shares: number) {
  const diff = side === "LONG" ? mark - entry : entry - mark;
  return Math.round(diff * shares * 100);
}
