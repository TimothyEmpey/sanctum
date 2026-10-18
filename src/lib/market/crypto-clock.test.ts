import { describe, expect, it } from "vitest";
import { fonzoWaitMs } from "@/lib/market/crypto-clock";

function wake(iso: string, elapsedMs = 0) {
  const now = new Date(iso);
  return new Date(now.getTime() + fonzoWaitMs(now, elapsedMs)).toISOString();
}

describe("Fonzo wait", () => {
  it("wakes at 23:25 UTC instead of sleeping through the buy", () => {
    expect(wake("2026-10-13T23:00:00.000Z")).toBe("2026-10-13T23:25:00.000Z");
    expect(wake("2026-10-13T23:09:07.736Z")).toBe("2026-10-13T23:25:00.000Z");
    expect(wake("2026-10-16T23:00:00.992Z")).toBe("2026-10-16T23:25:00.000Z");
    expect(wake("2026-10-13T23:24:30.000Z")).toBe("2026-10-13T23:25:00.000Z");
  });

  it("polls every 20 seconds through the entry and the first half-hour", () => {
    expect(fonzoWaitMs(new Date("2026-10-13T23:25:00.000Z"))).toBe(20_000);
    expect(fonzoWaitMs(new Date("2026-10-13T23:30:00.000Z"))).toBe(20_000);
    expect(fonzoWaitMs(new Date("2026-10-13T23:34:00.000Z"))).toBe(20_000);
    expect(fonzoWaitMs(new Date("2026-10-14T00:29:00.000Z"))).toBe(20_000);
    expect(fonzoWaitMs(new Date("2026-10-13T23:30:00.000Z"), 4_000)).toBe(16_000);
  });

  it("keeps the hourly heartbeat before 23:25", () => {
    expect(wake("2026-10-13T22:00:00.000Z")).toBe("2026-10-13T23:00:00.000Z");
    expect(wake("2026-10-13T00:40:00.000Z")).toBe("2026-10-13T01:00:00.000Z");
  });
});
