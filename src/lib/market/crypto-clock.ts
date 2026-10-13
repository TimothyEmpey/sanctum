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

/** 20s polls while the signal or the entry is near. Otherwise the next UTC hour. */
export function fonzoWaitMs(now: Date, elapsedMs = 0) {
  const minutes = utcParts(now).minutes;
  const hot = minutes >= 23 * 60 + 25 || minutes < 40;
  if (hot) return Math.max(1_000, 20_000 - elapsedMs);
  const intoHour = (now.getUTCMinutes() * 60 + now.getUTCSeconds()) * 1000 + (now.getTime() % 1000);
  const until = intoHour === 0 ? 60 * 60 * 1000 : 60 * 60 * 1000 - intoHour;
  return Math.max(1_000, until);
}
