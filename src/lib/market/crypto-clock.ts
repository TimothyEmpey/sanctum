export type CryptoPhase = "signal" | "wait" | "entry" | "manage" | "flatten";

export type CryptoClock = {
  phase: CryptoPhase;
  dateKey: string;
  minutes: number;
  entryWindowOpen: boolean;
  flattenDue: boolean;
  label: string;
};

export function utcParts(now: Date) {
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return {
    dateKey: now.toISOString().slice(0, 10),
    minutes,
    hour: now.getUTCHours(),
    minute: now.getUTCMinutes(),
  };
}

/** First half-hour ends at 00:30 UTC. Last half-hour starts at 23:30 UTC. */
export const CRYPTO_SIGNAL_END = 30;
export const CRYPTO_ENTRY_START = 23 * 60 + 30;
export const CRYPTO_ENTRY_GRACE = 5;
export const CRYPTO_FLATTEN_START = 23 * 60 + 59;

const LABELS: Record<CryptoPhase, string> = {
  signal: "Recording the first half-hour",
  wait: "Waiting for the last half-hour",
  entry: "Entry window",
  manage: "Managing open risk",
  flatten: "Flattening the session",
};

export function cryptoSessionClock(now: Date): CryptoClock {
  const z = utcParts(now);
  const entryEnd = CRYPTO_ENTRY_START + CRYPTO_ENTRY_GRACE;
  let phase: CryptoPhase = "wait";
  if (z.minutes < CRYPTO_SIGNAL_END) phase = "signal";
  else if (z.minutes < CRYPTO_ENTRY_START) phase = "wait";
  else if (z.minutes < entryEnd) phase = "entry";
  else if (z.minutes < CRYPTO_FLATTEN_START) phase = "manage";
  else phase = "flatten";
  return {
    phase,
    dateKey: z.dateKey,
    minutes: z.minutes,
    entryWindowOpen: phase === "entry",
    flattenDue: phase === "flatten",
    label: LABELS[phase],
  };
}

/** Polls start five minutes before the 23:30 UTC buy. */
const HOT_START_MINUTE = CRYPTO_ENTRY_START - 5;

/**
 * 20s polls from 23:25 UTC through 00:40 UTC. Otherwise the next UTC hour,
 * or 23:25 when that hour would sleep through the buy.
 */
export function fonzoWaitMs(now: Date, elapsedMs = 0) {
  const minutes = utcParts(now).minutes;
  const hot = minutes >= HOT_START_MINUTE || minutes < 40;
  if (hot) return Math.max(1_000, 20_000 - elapsedMs);
  const secondMs = now.getUTCSeconds() * 1000 + (now.getTime() % 1000);
  const intoHour = now.getUTCMinutes() * 60_000 + secondMs;
  const untilHour = intoHour === 0 ? 60 * 60 * 1000 : 60 * 60 * 1000 - intoHour;
  const untilHot = (HOT_START_MINUTE - minutes) * 60_000 - secondMs;
  return Math.max(1_000, Math.min(untilHour, untilHot));
}
