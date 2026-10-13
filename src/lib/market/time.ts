const etFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

export type EtParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
  dateKey: string;
  minutes: number;
};

export function etInstant(dateKey: string, hour: number, minute: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  for (let offset = -14; offset <= 14; offset += 1) {
    const guess = new Date(Date.UTC(year, month - 1, day, hour + offset, minute));
    const z = etParts(guess);
    if (z.dateKey === dateKey && z.hour === hour && z.minute === minute) return guess;
  }
  throw new Error(`No ${dateKey} ${hour}:${String(minute).padStart(2, "0")} ET instant`);
}

export function etParts(date: Date): EtParts {
  const parts = etFormat.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  let hour = Number(pick("hour"));
  if (hour === 24) hour = 0;
  const minute = Number(pick("minute"));
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour,
    minute,
    second: Number(pick("second")),
    weekday: pick("weekday"),
    dateKey: `${year}-${month}-${day}`,
    minutes: hour * 60 + minute,
  };
}

export function formatEt(date: Date, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...options,
  }).format(date);
}

export function formatEtDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function roundPrice(value: number) {
  return Math.round(value * 100) / 100;
}

export function cents(dollars: number) {
  return Math.round(dollars * 100);
}

export function formatUsd(centsValue: number, signed = false) {
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(centsValue / 100);
  if (!signed) return formatted;
  if (centsValue > 0) return `+${formatted}`;
  return formatted;
}

export function formatPx(value: number) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatQty(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

export function percentOf(part: number, whole: number) {
  if (whole === 0) return 0;
  return part / whole;
}
