import { etInstant, etParts } from "@/lib/market/time";

/** NYSE full closures for 2026. Source: NYSE hours calendar. */
export const NYSE_HOLIDAYS_2026 = new Set([
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
]);

/** Core session closes at 13:00 ET. */
export const NYSE_EARLY_CLOSE_2026 = new Set(["2026-11-27", "2026-12-24"]);

/** Start of the last half-hour. Gao, Han, Li, and Zhou enter here. */
export function lastHalfHourStart(earlyClose: boolean) {
  return earlyClose ? 12 * 60 + 30 : 15 * 60 + 30;
}

/** A missed 20-second poll can still send the 15:30 order. */
export const LAST_HALF_GRACE_MINUTES = 5;

/** Retired playbooks flatten here. The last-half-hour book holds until the cash close. */
export function retiredFlattenMinute(earlyClose: boolean) {
  return earlyClose ? 12 * 60 + 50 : 15 * 60 + 50;
}

export type SessionPhase =
  | "idle"
  | "preopen"
  | "opening_range"
  | "entry"
  | "manage"
  | "flatten"
  | "closed";

export type SessionClock = {
  phase: SessionPhase;
  dateKey: string;
  weekday: string;
  minutes: number;
  earlyClose: boolean;
  tradingDay: boolean;
  entryWindowOpen: boolean;
  flattenDue: boolean;
  label: string;
};

export function isWeekend(weekday: string) {
  return weekday === "Sat" || weekday === "Sun";
}

export function sessionClock(now: Date): SessionClock {
  const z = etParts(now);
  const holiday = NYSE_HOLIDAYS_2026.has(z.dateKey);
  const earlyClose = NYSE_EARLY_CLOSE_2026.has(z.dateKey);
  const tradingDay = !isWeekend(z.weekday) && !holiday;

  if (!tradingDay) {
    return {
      phase: "closed",
      dateKey: z.dateKey,
      weekday: z.weekday,
      minutes: z.minutes,
      earlyClose: false,
      tradingDay: false,
      entryWindowOpen: false,
      flattenDue: false,
      label: holiday ? "Market holiday" : "Market closed",
    };
  }

  const signalStart = 9 * 60 + 50;
  const lastHalf = lastHalfHourStart(earlyClose);
  const entryEnd = lastHalf + LAST_HALF_GRACE_MINUTES;
  const sessionEnd = earlyClose ? 13 * 60 : 16 * 60;
  const manageEnd = sessionEnd - 1;

  let phase: SessionPhase = "closed";
  if (z.minutes < 9 * 60 + 25) phase = "idle";
  else if (z.minutes < 9 * 60 + 30) phase = "preopen";
  else if (z.minutes < signalStart) phase = "opening_range";
  else if (z.minutes < lastHalf) phase = "manage";
  else if (z.minutes < entryEnd) phase = "entry";
  else if (z.minutes < manageEnd) phase = "manage";
  else if (z.minutes < sessionEnd + 15) phase = "flatten";

  const labels: Record<SessionPhase, string> = {
    idle: "Overnight watch",
    preopen: "Session baseline",
    opening_range: "Session open",
    entry: "Entry window",
    manage: "Managing open risk",
    flatten: "Flattening day trades",
    closed: earlyClose ? "Early close" : "Session complete",
  };

  return {
    phase,
    dateKey: z.dateKey,
    weekday: z.weekday,
    minutes: z.minutes,
    earlyClose,
    tradingDay,
    entryWindowOpen: phase === "entry",
    flattenDue: phase === "flatten",
    label: phase === "manage" && z.minutes < lastHalf ? "Waiting for the last half-hour" : labels[phase],
  };
}

/** Week key is the Monday date of the ET week, or the session date if earlier. */
export function weekKey(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const weekday = utc.getUTCDay();
  const delta = weekday === 0 ? 6 : weekday - 1;
  utc.setUTCDate(utc.getUTCDate() - delta);
  return utc.toISOString().slice(0, 10);
}

const QUIET_PHASES = new Set<SessionPhase>(["closed", "idle"]);

function shiftDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const cursor = new Date(Date.UTC(year, month - 1, day + days));
  return cursor.toISOString().slice(0, 10);
}

/** Next ET clock hour. An exact :00 waits for the following hour. */
export function nextTopOfHourEt(now: Date) {
  const z = etParts(now);
  const intoHour = (z.minute * 60 + z.second) * 1000 + (now.getTime() % 1000);
  const until = intoHour === 0 ? 60 * 60 * 1000 : 60 * 60 * 1000 - intoHour;
  return new Date(now.getTime() + until);
}

/** 9:25 ET on the next session, when the book leaves overnight watch. */
export function nextSessionWake(now: Date) {
  const startKey = etParts(now).dateKey;
  for (let offset = 0; offset < 14; offset += 1) {
    const key = shiftDateKey(startKey, offset);
    if (!sessionClock(etInstant(key, 12, 0)).tradingDay) continue;
    const wake = etInstant(key, 9, 25);
    if (wake.getTime() > now.getTime()) return wake;
  }
  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Active session: 20s polls. Closed market and overnight: the next ET hour,
 * or 9:25 ET when that arrives first.
 */
export function workerWaitMs(now: Date, elapsedMs = 0) {
  if (!QUIET_PHASES.has(sessionClock(now).phase)) return Math.max(1_000, 20_000 - elapsedMs);
  const target = Math.min(nextTopOfHourEt(now).getTime(), nextSessionWake(now).getTime());
  return Math.max(1_000, target - now.getTime());
}

export function previousBusinessDays(dateKey: string, count: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const cursor = new Date(Date.UTC(year, month - 1, day));
  const days: string[] = [];
  while (days.length < count) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const key = cursor.toISOString().slice(0, 10);
    const weekday = cursor.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (NYSE_HOLIDAYS_2026.has(key)) continue;
    days.push(key);
  }
  return days;
}
