import { LAST_HALF_GRACE_MINUTES, lastHalfHourStart, sessionClock } from "@/lib/market/calendar";
import { etParts, roundPrice } from "@/lib/market/time";
import { priceAtTen, type Bar } from "@/lib/strategy/intraday-momentum";
import type { NqState } from "@/lib/strategy/nq-sweep";

export type TriggerState = "waiting" | "flat" | "up" | "missing";

/** Retired last-half-hour comparison. Live SPY and NQ do not use this. */
export function stockTrigger(now: Date, bars: Bar[], priorClose: number | null): TriggerState {
  const z = etParts(now);
  if (z.minutes < 10 * 60) return "waiting";
  const ten = priceAtTen(bars, z.dateKey, z.minutes);
  if (ten == null || priorClose == null || !(priorClose > 0)) return "missing";
  return roundPrice(ten) > roundPrice(priorClose) ? "up" : "flat";
}

export function heartbeatFresh(at: string | null | undefined, quiet: boolean, nowMs = Date.now()) {
  if (!at) return false;
  const age = nowMs - new Date(at).getTime();
  return age < (quiet ? 75 * 60_000 : 90_000);
}

/** A size reduction still allows the order. A closed entry window is not an error. */
export function blockingReason(reasons: string[] | null | undefined) {
  const reason = reasons?.find(
    (line) => !line.startsWith("Position size reduced") && !line.startsWith("New positions are closed during"),
  );
  return reason ?? null;
}

export function describeAssetTrigger(input: {
  market: "nyse" | "crypto";
  now: Date;
  minutes: Bar[];
  priorClose: number | null;
  traded: boolean;
  paused: boolean;
  workerName: "Uriel" | "Fonzo";
  haltReason: string | null;
  workerFresh: boolean;
  riskReason: string | null;
}) {
  if (input.traded) return null;
  if (input.market === "crypto") {
    return input.minutes.length < 5
      ? "Signal prices are missing. This is not a flat day."
      : "Playbook trigger is not in yet.";
  }
  if (!sessionClock(input.now).tradingDay) return "Cash market is closed.";

  const trigger = stockTrigger(input.now, input.minutes, input.priorClose);
  if (trigger === "waiting") return "Playbook trigger is not in yet.";
  if (trigger === "flat") return "Playbook trigger was not hit.";
  if (trigger === "missing") return "Signal prices are missing. This is not a flat day.";

  const window = stockWindow(input.now);
  if (!window.open && !window.passed) return null;
  const block = input.haltReason ?? (input.paused ? `${input.workerName} is paused.` : null) ?? (input.workerFresh ? null : "Worker is offline.") ?? input.riskReason;
  if (block) return `Buy is flagged. No order: ${block}`;
  if (window.passed) return "Buy was flagged. No order was sent.";
  return null;
}

/** Price-action sequence. A short setup is not a buy. The 10:00 stock test does not apply. */
export function describeSequenceTrigger(state: NqState, block: string | null) {
  if (state === "waiting") return "Playbook trigger is not in yet.";
  if (state === "missing") return "Signal prices are missing. This is not a flat day.";
  if (state === "flat") return "Playbook trigger was not hit.";
  if (block) return `Buy is flagged. No order: ${block}`;
  if (state === "passed") return "Buy was flagged. No order was sent.";
  return null;
}

export function describeNqTrigger(state: NqState, block: string | null) {
  return describeSequenceTrigger(state, block);
}

export function describeSpyTrigger(state: NqState, block: string | null) {
  return describeSequenceTrigger(state, block);
}

function stockWindow(now: Date) {
  const clock = sessionClock(now);
  const start = lastHalfHourStart(clock.earlyClose);
  const end = start + LAST_HALF_GRACE_MINUTES;
  return { open: clock.minutes >= start && clock.minutes < end, passed: clock.minutes >= end };
}


