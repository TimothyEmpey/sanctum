import { describe, expect, it } from "vitest";
import { fonzoWaitMs } from "@/lib/market/crypto-clock";

describe("Fonzo wait", () => {
  it("polls every 20 seconds at every hour while the process is running", () => {
    for (const iso of [
      "2026-10-13T00:10:00.000Z",
      "2026-10-13T14:00:00.000Z",
      "2026-10-13T23:00:00.000Z",
      "2026-10-13T23:09:07.736Z",
      "2026-10-13T23:30:00.000Z",
      "2026-10-16T23:00:00.992Z",
    ]) {
      expect(fonzoWaitMs(new Date(iso))).toBe(20_000);
    }
    expect(fonzoWaitMs(new Date("2026-10-13T23:30:00.000Z"), 4_000)).toBe(16_000);
    expect(fonzoWaitMs(new Date("2026-10-13T14:00:00.000Z"), 19_500)).toBe(1_000);
  });
});
