import { roundPrice } from "@/lib/market/time";
import type { Bar } from "@/lib/strategy/intraday-momentum";
import type { Side } from "@/lib/risk/types";

/** Long only, in the bottom quarter of a broken range. The same rules apply to BTC and ETH. */
export const CRYPTO_SETUP = "CRYPTO_DISCOUNT";

const HOUR_MS = 60 * 60 * 1000;
const FRAMES = [8, 4, 1] as const;

export type CryptoState = "waiting" | "flat" | "missing" | "ready" | "passed";

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
  state: CryptoState;
  standDown: string | null;
  proposal: CryptoProposal | null;
  note: string;
  frameHours: number | null;
};

type Swing = { index: number; price: number };

function done(
  state: CryptoState,
  note: string,
  standDown: string | null = null,
  proposal: CryptoProposal | null = null,
  frameHours: number | null = null,
): CryptoSnapshot {
  return { ready: proposal != null, state, standDown, proposal, note, frameHours };
}

/** Completed UTC buckets. An eight-hour bar ends at 00:00, 08:00, or 16:00 UTC. */
export function aggregateHours(bars: Bar[], hours: number, nowMs: number) {
  const size = hours * HOUR_MS;
  const groups = new Map<number, Bar[]>();
  for (const bar of bars) {
    if (!(bar.ts < nowMs)) continue;
    const bucket = Math.floor(bar.ts / size) * size;
    if (nowMs < bucket + size) continue;
    const list = groups.get(bucket) ?? [];
    list.push(bar);
    groups.set(bucket, list);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, list]) => {
      const ordered = [...list].sort((a, b) => a.ts - b.ts);
      const last = ordered[ordered.length - 1];
      return {
        ts,
        open: ordered[0].open,
        high: Math.max(...ordered.map((bar) => bar.high)),
        low: Math.min(...ordered.map((bar) => bar.low)),
        close: last.close,
        volume: ordered.reduce((sum, bar) => sum + bar.volume, 0),
      } satisfies Bar;
    });
}

function swings(bars: Bar[]) {
  const highs: Swing[] = [];
  const lows: Swing[] = [];
  for (let index = 1; index < bars.length - 1; index += 1) {
    const bar = bars[index];
    if (bar.high >= bars[index - 1].high && bar.high > bars[index + 1].high) highs.push({ index, price: bar.high });
    if (bar.low <= bars[index - 1].low && bar.low < bars[index + 1].low) lows.push({ index, price: bar.low });
  }
  return { highs, lows };
}

function frameName(hours: number) {
  if (hours === 8) return "Eight-hour";
  if (hours === 4) return "Four-hour";
  return "One-hour";
}

type LongRange = { bottom: number; broken: number; top: number; returned: boolean };
type ShortRange = { top: number; bottom: number };

function readStructure(bars: Bar[]) {
  const { highs, lows } = swings(bars);
  let long: LongRange | null = null;
  let short: ShortRange | null = null;
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    if (long) {
      if (bar.low <= long.bottom) long = null;
      else {
        long.top = Math.max(long.top, bar.high);
        if (bar.low < long.broken) long.returned = true;
        continue;
      }
    }
    if (short) {
      if (bar.high >= short.top) short = null;
      else continue;
    }
    const high = highs.filter((swing) => swing.index < index).at(-1);
    const lowBeforeHigh = high ? lows.filter((swing) => swing.index < high.index).at(-1) : null;
    if (high && lowBeforeHigh && bar.close > high.price) {
      const span = bars.slice(lowBeforeHigh.index, index + 1);
      long = {
        bottom: lowBeforeHigh.price,
        broken: high.price,
        top: Math.max(...span.map((item) => item.high)),
        returned: false,
      };
      continue;
    }
    const low = lows.filter((swing) => swing.index < index).at(-1);
    const highBeforeLow = low ? highs.filter((swing) => swing.index < low.index).at(-1) : null;
    if (low && highBeforeLow && bar.close < low.price) {
      short = { top: highBeforeLow.price, bottom: low.price };
    }
  }
  return { long, short };
}

function fromFrame(
  bars: Bar[],
  hours: number,
  input: { symbol: "BTC/USD" | "ETH/USD"; strategy: string },
): CryptoSnapshot {
  const last = bars[bars.length - 1];
  const { long, short } = readStructure(bars);
  if (long && last && long.returned && last.low > long.bottom) {
    const entry = roundPrice(long.bottom + 0.25 * (long.top - long.bottom));
    const stop = roundPrice(long.bottom);
    const target = roundPrice(long.top);
    if (last.low <= entry && stop < entry && entry < target) {
      return done(
        "ready",
        "Discount long. The stop is the swing low and the target is the range high.",
        null,
        {
          symbol: input.symbol,
          side: "LONG",
          entryPrice: entry,
          stopPrice: stop,
          targetPrice: target,
          setup: CRYPTO_SETUP,
          strategy: input.strategy,
          reason: `${frameName(hours)} discount. Price broke the swing high, came back inside the range, and traded into the bottom quarter. The stop is the swing low. The target is the range high.`,
          signalBarTs: last.ts,
          market: "crypto",
        },
        hours,
      );
    }
  }
  if (!long && short && last) {
    const premium = short.top - 0.25 * (short.top - short.bottom);
    if (last.high >= premium && last.high < short.top) {
      return done("flat", "Playbook trigger was not hit.", "The short setup is off. This book does not short.", null, hours);
    }
  }
  return done("waiting", "Playbook trigger is not in yet.", null, null, hours);
}

/**
 * Buy the bottom quarter after price breaks a swing high and trades back inside the range.
 * The eight-hour chart is read first. A lower chart is used only when the higher one has no swing.
 */
export function evaluateCryptoDiscount(input: {
  now: Date;
  bars: Bar[];
  symbol: "BTC/USD" | "ETH/USD";
  strategy: string;
  hasOpenPosition: boolean;
  tradesTaken: number;
  maxTrades?: number;
}): CryptoSnapshot {
  if (input.hasOpenPosition || input.tradesTaken >= (input.maxTrades ?? 1)) {
    return done("flat", `${input.symbol} already has its entry for this session.`);
  }
  const nowMs = input.now.getTime();
  let sawBars = false;
  for (const hours of FRAMES) {
    const framed = aggregateHours(input.bars, hours, nowMs);
    if (framed.length < 5) continue;
    sawBars = true;
    const { highs, lows } = swings(framed);
    if (highs.length === 0 || lows.length === 0) continue;
    return fromFrame(framed, hours, input);
  }
  if (!sawBars) {
    return done("missing", "Signal prices are missing. This is not a flat day.", "Signal prices are missing. This is not a flat day.");
  }
  return done("waiting", "Playbook trigger is not in yet.");
}
