import { LAST_HALF_GRACE_MINUTES, lastHalfHourStart, sessionClock } from "@/lib/market/calendar";
import { CRYPTO_ENTRY_GRACE, CRYPTO_ENTRY_START, CRYPTO_SIGNAL_END, cryptoSessionClock, utcParts } from "@/lib/market/crypto-clock";
import { etParts, roundPrice } from "@/lib/market/time";
import { firstHalfReturn } from "@/lib/strategy/crypto-momentum";
import { priceAtTen, type Bar } from "@/lib/strategy/intraday-momentum";

export type TriggerState = "waiting" | "flat" | "up" | "missing";

/** Same 10:00 ET comparison the stock playbook uses. */
export function stockTrigger(now: Date, bars: Bar[], priorClose: number | null): TriggerState {
  const z = etParts(now);
  if (z.minutes < 10 * 60) return "waiting";
  const ten = priceAtTen(bars, z.dateKey, z.minutes);
  if (ten == null || priorClose == null || !(priorClose > 0)) return "missing";
  return roundPrice(ten) > roundPrice(priorClose) ? "up" : "flat";
}

/** Same 00:00–00:30 UTC comparison the crypto playbook uses. */
export function cryptoTrigger(now: Date, bars: Bar[]): TriggerState {
  const z = utcParts(now);
  if (z.minutes < CRYPTO_SIGNAL_END) return "waiting";
  const signal = firstHalfReturn(bars, z.dateKey, z.minutes);
  if (!signal) return "missing";
  return signal.up ? "up" : "flat";
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
  if (input.market === "nyse" && !sessionClock(input.now).tradingDay) return "Cash market is closed.";

  const trigger = input.market === "crypto" ? cryptoTrigger(input.now, input.minutes) : stockTrigger(input.now, input.minutes, input.priorClose);
  if (trigger === "waiting") return "Playbook trigger is not in yet.";
  if (trigger === "flat") return "Playbook trigger was not hit.";
  if (trigger === "missing") return "Signal prices are missing. This is not a flat day.";

  const window = input.market === "crypto" ? cryptoWindow(input.now) : stockWindow(input.now);
  if (!window.open && !window.passed) return null;
  const block = input.haltReason ?? (input.paused ? `${input.workerName} is paused.` : null) ?? (input.workerFresh ? null : "Worker is offline.") ?? input.riskReason;
  if (block) return `Buy is flagged. No order: ${block}`;
  if (window.passed) return "Buy was flagged. No order was sent.";
  return null;
}

function stockWindow(now: Date) {
  const clock = sessionClock(now);
  const start = lastHalfHourStart(clock.earlyClose);
  const end = start + LAST_HALF_GRACE_MINUTES;
  return { open: clock.minutes >= start && clock.minutes < end, passed: clock.minutes >= end };
}

function cryptoWindow(now: Date) {
  const clock = cryptoSessionClock(now);
  const end = CRYPTO_ENTRY_START + CRYPTO_ENTRY_GRACE;
  return { open: clock.entryWindowOpen, passed: clock.minutes >= end };
}
