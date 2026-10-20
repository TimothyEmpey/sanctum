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

/**
 * Crypto has no cash session. While Fonzo's process is running he can buy or sell.
 * `fonzo stop` and `sanctum stop` are what take him offline. A clock does not flatten him.
 */
export function cryptoSessionClock(now: Date): CryptoClock {
  const z = utcParts(now);
  return {
    phase: "manage",
    dateKey: z.dateKey,
    minutes: z.minutes,
    entryWindowOpen: true,
    flattenDue: false,
    label: "Crypto session",
  };
}

/**
 * Fonzo stays on a 20-second poll for as long as the process is running.
 * `fonzo stop` and `sanctum stop` are what take him offline.
 */
export function fonzoWaitMs(_now: Date, elapsedMs = 0) {
  return Math.max(1_000, 20_000 - elapsedMs);
}
