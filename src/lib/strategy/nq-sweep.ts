import { sessionClock } from "@/lib/market/calendar";
import { etParts, roundPrice } from "@/lib/market/time";
import type { Bar } from "@/lib/strategy/intraday-momentum";

/** Nasdaq-100 futures. Long continuation only. Shorts stay off. */
export const NQ_SETUP = "NQ_SWEEP";
export const NQ_STRATEGY_ID = "nq-liquidity-sweep";

const OPEN_MINUTE = 9 * 60 + 30;
const ALIGN_BY = 10 * 60 + 20;
const ENTRY_END = 10 * 60 + 30;
const ENTRY_GRACE_MS = 5 * 60_000;

export type NqState = "waiting" | "flat" | "missing" | "ready" | "passed";

export type NqProposal = {
  symbol: "NQ";
  side: "LONG";
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  setup: typeof NQ_SETUP;
  strategy: typeof NQ_STRATEGY_ID;
  reason: string;
  signalBarTs: number;
};

export type NqSnapshot = {
  ready: boolean;
  state: NqState;
  standDown: string | null;
  proposal: NqProposal | null;
  note: string;
  orHigh: number | null;
  orLow: number | null;
  vwap: number | null;
};

type Swing = { index: number; price: number; ts: number };

function done(state: NqState, note: string, standDown: string | null = null, proposal: NqProposal | null = null): NqSnapshot {
  return { ready: proposal != null, state, standDown, proposal, note, orHigh: null, orLow: null, vwap: null };
}

function onDate(bars: Bar[], dateKey: string) {
  return bars
    .filter((bar) => etParts(new Date(bar.ts)).dateKey === dateKey)
    .sort((a, b) => a.ts - b.ts);
}

function completed(bars: Bar[], now: Date) {
  return bars.filter((bar) => bar.ts + 60_000 <= now.getTime());
}

function fiveMinute(bars: Bar[]) {
  const groups = new Map<number, Bar[]>();
  for (const bar of bars) {
    const z = etParts(new Date(bar.ts));
    const bucket = Math.floor(z.minutes / 5) * 5;
    const list = groups.get(bucket) ?? [];
    list.push(bar);
    groups.set(bucket, list);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, list]) => {
      const ordered = [...list].sort((a, b) => a.ts - b.ts);
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      return {
        ts: first.ts,
        open: first.open,
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
    if (bar.high >= bars[index - 1].high && bar.high > bars[index + 1].high) highs.push({ index, price: bar.high, ts: bar.ts });
    if (bar.low <= bars[index - 1].low && bar.low < bars[index + 1].low) lows.push({ index, price: bar.low, ts: bar.ts });
  }
  return { highs, lows };
}

function structureBreaks(bars: Bar[], direction: "up" | "down", afterTs = 0) {
  const { highs, lows } = swings(bars);
  const found: Bar[] = [];
  for (let index = 2; index < bars.length; index += 1) {
    const bar = bars[index];
    if (bar.ts < afterTs) continue;
    const swing = (direction === "up" ? highs : lows).filter((item) => item.index < index).at(-1);
    if (!swing) continue;
    if (direction === "up" ? bar.close > swing.price : bar.close < swing.price) found.push(bar);
  }
  return found;
}

function biasAt(bars: Bar[], deadlineMinute: number) {
  const up = structureBreaks(bars, "up").filter((bar) => barEnd(bar) <= deadlineMinute).at(-1);
  const down = structureBreaks(bars, "down").filter((bar) => barEnd(bar) <= deadlineMinute).at(-1);
  if (!up && !down) return null;
  if (!down || (up && up.ts >= down.ts)) return "up";
  return "down";
}

function minuteOf(bar: Bar) {
  return etParts(new Date(bar.ts)).minutes;
}

function barEnd(bar: Bar) {
  return minuteOf(bar) + 5;
}

/** True while a 9:30–10:29 ET signal can still be sent, plus the five-minute grace. */
export function nqWatchOpen(now: Date) {
  const clock = sessionClock(now);
  if (!clock.tradingDay) return false;
  return clock.minutes >= OPEN_MINUTE && clock.minutes < ENTRY_END + 5;
}

export function evaluateNqSweep(input: {
  now: Date;
  bars: Bar[];
  esBars: Bar[];
  priorHigh: number | null;
  priorLow: number | null;
  hasOpenPosition: boolean;
  tradesTaken: number;
  maxTrades?: number;
}): NqSnapshot {
  const clock = sessionClock(input.now);
  if (!clock.tradingDay) return done("flat", "Cash market is closed.", "Cash market is closed.");
  if (clock.minutes < OPEN_MINUTE) return done("waiting", "Playbook trigger is not in yet.");
  if (input.hasOpenPosition || input.tradesTaken >= (input.maxTrades ?? 1)) {
    return done("flat", "NQ already has its entry for this session.");
  }
  if (!(input.priorLow != null && input.priorLow > 0) || !(input.priorHigh != null && input.priorHigh > 0)) {
    return done("missing", "Signal prices are missing. This is not a flat day.", "The prior day high and low are missing. This is not a flat day.");
  }

  const nq = completed(onDate(input.bars, clock.dateKey), input.now);
  const es = completed(onDate(input.esBars, clock.dateKey), input.now);
  if (nq.length < 3 || es.length < 3) {
    return done("missing", "Signal prices are missing. This is not a flat day.", "Nasdaq or S&P futures bars are missing. This is not a flat day.");
  }

  const premarket = nq.filter((bar) => minuteOf(bar) < OPEN_MINUTE);
  const drawLow = Math.min(input.priorLow, ...premarket.map((bar) => bar.low));
  const drawHigh = Math.max(input.priorHigh, ...premarket.map((bar) => bar.high));
  const cash = nq.filter((bar) => minuteOf(bar) >= OPEN_MINUTE);
  const sweep = cash.find((bar) => bar.low < drawLow) ?? null;
  const nqFive = fiveMinute(nq).filter((bar) => bar.ts + 5 * 60_000 <= input.now.getTime());
  const esFive = fiveMinute(es).filter((bar) => bar.ts + 5 * 60_000 <= input.now.getTime());
  const nqUp = sweep ? structureBreaks(nqFive, "up", sweep.ts).find((bar) => barEnd(bar) <= ALIGN_BY) ?? null : null;
  const aligned = nqUp != null && biasAt(nqFive, ALIGN_BY) === "up" && biasAt(esFive, ALIGN_BY) === "up";

  if (!sweep || !aligned || !nqUp) {
    const sweptHigh = cash.some((bar) => bar.high > drawHigh);
    const nqDown = structureBreaks(nqFive, "down")[0];
    if (sweptHigh && nqDown && barEnd(nqDown) <= ALIGN_BY && biasAt(nqFive, ALIGN_BY) === "down") {
      return done("flat", "Playbook trigger was not hit.", "The short setup is off. This book does not short.");
    }
    if (clock.minutes < ALIGN_BY) return done("waiting", "Playbook trigger is not in yet.");
    return done("flat", "Playbook trigger was not hit.", "Nasdaq and S&P futures did not align by 10:20 ET. No buy.");
  }

  const after = nq.filter((bar) => bar.ts >= nqUp.ts + 5 * 60_000);
  const down = structureBreaks(after, "down")[0];
  const up = down ? structureBreaks(after.filter((bar) => bar.ts > down.ts), "up")[0] : null;
  if (!up || minuteOf(up) >= ENTRY_END) {
    if (clock.minutes < ENTRY_END) return done("waiting", "Playbook trigger is not in yet.");
    return done("flat", "Playbook trigger was not hit.", "The one-minute continuation did not print before 10:30 ET.");
  }

  const retraceLow = swings(after.filter((bar) => bar.ts <= down.ts)).lows.at(-1)?.price ?? down.low;
  const entry = roundPrice(up.close);
  const stop = roundPrice(retraceLow);
  const highs = swings(nqFive).highs.map((swing) => swing.price).filter((price) => price > entry);
  if (drawHigh > entry) highs.push(drawHigh);
  const target = highs.length > 0 ? roundPrice(Math.min(...highs)) : null;
  if (!(stop > 0) || stop >= entry || target == null || target <= entry) {
    return done("flat", "Playbook trigger was not hit.", "The continuation had no stop below the entry and no draw above it.");
  }

  const expired = input.now.getTime() > up.ts + 60_000 + ENTRY_GRACE_MS;
  const proposal: NqProposal = {
    symbol: "NQ",
    side: "LONG",
    entryPrice: entry,
    stopPrice: stop,
    targetPrice: target,
    setup: NQ_SETUP,
    strategy: NQ_STRATEGY_ID,
    reason: "Nasdaq swept the prior low, broke five-minute structure up with S&P futures, and confirmed on the one minute.",
    signalBarTs: up.ts,
  };
  if (expired) return done("passed", "Buy was flagged. No order was sent.", "The Nasdaq continuation entry has passed.", proposal);
  return done("ready", "Buy is flagged.", null, proposal);
}
