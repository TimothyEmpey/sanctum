import { sessionClock } from "@/lib/market/calendar";
import { etParts, roundPrice } from "@/lib/market/time";
import type { Bar } from "@/lib/strategy/intraday-momentum";

/**
 * Long-only price action. A long is a 15-minute sweep of a swing low that
 * then closes above the high in place, or a 15-minute uptrend that retraces
 * with a 5-minute break and closes back above that high. Shorts stay off.
 */
export const SPY_SETUP = "SPY_STRUCTURE";
export const SPY_STRATEGY_ID = "spy-price-action";
export const SPY_STRATEGY_NAME = "SPY price action, long-only";

const OPEN = 9 * 60 + 30;
const GRACE_MS = 5 * 60_000;

export type SpyState = "waiting" | "flat" | "missing" | "ready" | "passed";

export type SpyProposal = {
  symbol: "SPY";
  side: "LONG";
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  setup: typeof SPY_SETUP;
  strategy: typeof SPY_STRATEGY_ID;
  reason: string;
  signalBarTs: number;
};

export type SpySnapshot = {
  ready: boolean;
  state: SpyState;
  standDown: string | null;
  proposal: SpyProposal | null;
  note: string;
  orHigh: number | null;
  orLow: number | null;
  vwap: number | null;
};

type Swing = { index: number; price: number };
type Signal = { barTs: number; endMs: number; entry: number; stop: number; target: number; reason: string };

function done(state: SpyState, note: string, standDown: string | null = null, proposal: SpyProposal | null = null): SpySnapshot {
  return { ready: state === "ready", state, standDown, proposal, note, orHigh: null, orLow: null, vwap: null };
}

function sessionEnd(earlyClose: boolean) {
  return earlyClose ? 13 * 60 : 16 * 60;
}

/** True from the cash open until the cash flatten. The 15:30 clock does not apply. */
export function spyWatchOpen(now: Date) {
  const clock = sessionClock(now);
  if (!clock.tradingDay || clock.phase === "closed") return false;
  return clock.minutes >= OPEN && !clock.flattenDue;
}

function aggregate(bars: Bar[], span: number, now: Date, endMinute: number) {
  const groups = new Map<string, Bar[]>();
  for (const bar of bars) {
    const z = etParts(new Date(bar.ts));
    if (z.minutes < OPEN || z.minutes >= endMinute) continue;
    const bucket = Math.floor(z.minutes / span) * span;
    const key = `${z.dateKey}-${bucket}`;
    const list = groups.get(key) ?? [];
    list.push(bar);
    groups.set(key, list);
  }
  return [...groups.values()]
    .map((list) => {
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
    })
    .filter((bar) => bar.ts + span * 60_000 <= now.getTime())
    .sort((a, b) => a.ts - b.ts);
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

function structureBreaks(bars: Bar[]) {
  const { highs, lows } = swings(bars);
  const events: { dir: "up" | "down"; index: number }[] = [];
  for (let index = 2; index < bars.length; index += 1) {
    const bar = bars[index];
    const high = highs.filter((item) => item.index < index).at(-1);
    const low = lows.filter((item) => item.index < index).at(-1);
    if (high && bar.close > high.price) events.push({ dir: "up", index });
    if (low && bar.close < low.price) events.push({ dir: "down", index });
  }
  return events;
}

function targetFor(entry: number, stop: number, highs: number[], priorHigh: number | null) {
  const above = highs.filter((price) => price > entry);
  if (priorHigh != null && priorHigh > entry) above.push(priorHigh);
  if (above.length > 0) return roundPrice(Math.min(...above));
  const measured = roundPrice(entry + (entry - stop));
  return measured > entry ? measured : null;
}

function proposalFrom(signal: Signal): SpyProposal {
  return {
    symbol: "SPY",
    side: "LONG",
    entryPrice: signal.entry,
    stopPrice: signal.stop,
    targetPrice: signal.target,
    setup: SPY_SETUP,
    strategy: SPY_STRATEGY_ID,
    reason: signal.reason,
    signalBarTs: signal.barTs,
  };
}

function reversalSignals(fifteen: Bar[], dateKey: string, priorHigh: number | null, priorLow: number | null) {
  const { highs, lows } = swings(fifteen);
  const found: Signal[] = [];
  for (let sweep = 2; sweep < fifteen.length; sweep += 1) {
    const sweptSwing = lows.some((item) => item.index < sweep && fifteen[sweep].low < item.price);
    const sweptPrior = priorLow != null && fifteen[sweep].low < priorLow;
    const refHigh = highs.filter((item) => item.index < sweep).at(-1);
    if ((!sweptSwing && !sweptPrior) || !refHigh) continue;
    for (let confirm = sweep + 1; confirm < fifteen.length; confirm += 1) {
      if (!(fifteen[confirm].close > refHigh.price)) continue;
      if (etParts(new Date(fifteen[confirm].ts)).dateKey !== dateKey) break;
      const stop = roundPrice(Math.min(...fifteen.slice(sweep, confirm + 1).map((bar) => bar.low)));
      const entry = roundPrice(fifteen[confirm].close);
      const target = targetFor(entry, stop, highs.map((item) => item.price), priorHigh);
      if (!(stop > 0) || stop >= entry || target == null || target <= entry) break;
      found.push({
        barTs: fifteen[confirm].ts,
        endMs: fifteen[confirm].ts + 15 * 60_000,
        entry,
        stop,
        target,
        reason: "SPY traded under a 15-minute low and closed back above the high that was in place.",
      });
      break;
    }
  }
  return found;
}

function continuationSignals(five: Bar[], fifteen: Bar[], dateKey: string, priorHigh: number | null) {
  const { highs, lows } = swings(five);
  const found: Signal[] = [];
  for (const down of structureBreaks(five).filter((event) => event.dir === "down")) {
    const knownAt = five[down.index].ts + 5 * 60_000;
    const higher = fifteen.filter((bar) => bar.ts + 15 * 60_000 <= knownAt);
    if (structureBreaks(higher).at(-1)?.dir !== "up") continue;
    const higherLow = swings(higher).lows.at(-1);
    if (higherLow && five[down.index].close < higherLow.price) continue;
    for (let confirm = down.index + 1; confirm < five.length; confirm += 1) {
      const high = highs.filter((item) => item.index < confirm).at(-1);
      if (!high || !(five[confirm].close > high.price)) continue;
      if (etParts(new Date(five[confirm].ts)).dateKey !== dateKey) break;
      const from = lows.filter((item) => item.index < down.index).at(-1)?.index ?? down.index;
      const stop = roundPrice(Math.min(...five.slice(from, confirm + 1).map((bar) => bar.low)));
      const entry = roundPrice(five[confirm].close);
      const swingHighs = [...highs.map((item) => item.price), ...swings(fifteen).highs.map((item) => item.price)];
      const target = targetFor(entry, stop, swingHighs, priorHigh);
      if (!(stop > 0) || stop >= entry || target == null || target <= entry) break;
      found.push({
        barTs: five[confirm].ts,
        endMs: five[confirm].ts + 5 * 60_000,
        entry,
        stop,
        target,
        reason: "SPY held a 15-minute uptrend, retraced on the 5-minute, and closed back above that high.",
      });
      break;
    }
  }
  return found;
}

function shortPrinted(fifteen: Bar[], five: Bar[], dateKey: string) {
  const { highs, lows } = swings(fifteen);
  for (let sweep = 2; sweep < fifteen.length; sweep += 1) {
    const swept = highs.some((item) => item.index < sweep && fifteen[sweep].high > item.price);
    const refLow = lows.filter((item) => item.index < sweep).at(-1);
    if (!swept || !refLow) continue;
    for (let confirm = sweep + 1; confirm < fifteen.length; confirm += 1) {
      if (!(fifteen[confirm].close < refLow.price)) continue;
      if (etParts(new Date(fifteen[confirm].ts)).dateKey === dateKey) return true;
      break;
    }
  }
  const fiveSwings = swings(five);
  for (const up of structureBreaks(five).filter((event) => event.dir === "up")) {
    const knownAt = five[up.index].ts + 5 * 60_000;
    const higher = fifteen.filter((bar) => bar.ts + 15 * 60_000 <= knownAt);
    if (structureBreaks(higher).at(-1)?.dir !== "down") continue;
    const higherHigh = swings(higher).highs.at(-1);
    if (higherHigh && five[up.index].close > higherHigh.price) continue;
    for (let confirm = up.index + 1; confirm < five.length; confirm += 1) {
      const low = fiveSwings.lows.filter((item) => item.index < confirm).at(-1);
      if (!low || !(five[confirm].close < low.price)) continue;
      if (etParts(new Date(five[confirm].ts)).dateKey === dateKey) return true;
      break;
    }
  }
  return false;
}

export function evaluateSpyStructure(input: {
  now: Date;
  bars: Bar[];
  priorHigh: number | null;
  priorLow: number | null;
  hasOpenPosition: boolean;
  tradesTaken: number;
  maxTrades?: number;
}): SpySnapshot {
  const clock = sessionClock(input.now);
  if (!clock.tradingDay) return done("flat", "Cash market is closed.", "Cash market is closed.");
  if (clock.minutes < OPEN) return done("waiting", "Playbook trigger is not in yet.");
  if (input.hasOpenPosition || input.tradesTaken >= (input.maxTrades ?? 1)) {
    return done("flat", "SPY already has its entry for this session.");
  }

  const end = sessionEnd(clock.earlyClose);
  const today = input.bars.filter((bar) => etParts(new Date(bar.ts)).dateKey === clock.dateKey && etParts(new Date(bar.ts)).minutes >= OPEN);
  if (today.length === 0) {
    return clock.minutes < OPEN + 15
      ? done("waiting", "Playbook trigger is not in yet.")
      : done("missing", "Signal prices are missing. This is not a flat day.", "SPY bars are missing. This is not a flat day.");
  }

  const fifteen = aggregate(input.bars, 15, input.now, end);
  const five = aggregate(input.bars, 5, input.now, end);
  const priorHigh = input.priorHigh != null && input.priorHigh > 0 ? input.priorHigh : null;
  const priorLow = input.priorLow != null && input.priorLow > 0 ? input.priorLow : null;
  const signals = [...reversalSignals(fifteen, clock.dateKey, priorHigh, priorLow), ...continuationSignals(five, fifteen, clock.dateKey, priorHigh)].sort(
    (a, b) => a.endMs - b.endMs || a.barTs - b.barTs,
  );
  const nowMs = input.now.getTime();
  const live = signals.filter((signal) => nowMs >= signal.endMs && nowMs <= signal.endMs + GRACE_MS);
  const chosen = live.at(-1) ?? null;
  if (chosen) {
    return spyWatchOpen(input.now)
      ? done("ready", "Buy is flagged.", null, proposalFrom(chosen))
      : done("passed", "Buy was flagged. No order was sent.", null, proposalFrom(chosen));
  }
  const expired = signals.filter((signal) => nowMs > signal.endMs + GRACE_MS);
  const missed = expired.at(-1) ?? null;
  if (missed) return done("passed", "Buy was flagged. No order was sent.", null, proposalFrom(missed));
  if (spyWatchOpen(input.now)) return done("waiting", "Playbook trigger is not in yet.");
  if (shortPrinted(fifteen, five, clock.dateKey)) {
    return done("flat", "Playbook trigger was not hit.", "The short setup is off. This book does not short.");
  }
  return done("flat", "Playbook trigger was not hit.");
}
