import { describe, expect, it } from "vitest";
import { etInstant } from "@/lib/market/time";
import { blockingReason, describeAssetTrigger, describeNqTrigger, describeSpyTrigger } from "@/lib/strategy/trigger-caveat";
import type { Bar } from "@/lib/strategy/intraday-momentum";

function bar(ts: number, close: number, open = close): Bar {
  return { ts, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1 };
}

const base = {
  traded: false,
  paused: false,
  haltReason: null,
  workerFresh: true,
  riskReason: null,
};

describe("trigger caveat", () => {
  it("says the stock trigger is not in before 10:00 ET", () => {
    const text = describeAssetTrigger({
      ...base,
      market: "nyse",
      now: etInstant("2026-10-14", 9, 45),
      minutes: [],
      priorClose: 100,
      workerName: "Uriel",
    });
    expect(text).toBe("Playbook trigger is not in yet.");
  });

  it("says the stock trigger was not hit when 10:00 is not above the previous close", () => {
    const now = etInstant("2026-10-14", 15, 40);
    const text = describeAssetTrigger({
      ...base,
      market: "nyse",
      now,
      minutes: [bar(etInstant("2026-10-14", 9, 59).getTime(), 100)],
      priorClose: 100,
      workerName: "Uriel",
    });
    expect(text).toBe("Playbook trigger was not hit.");
  });

  it("names a missing signal instead of a flat day", () => {
    const text = describeAssetTrigger({
      ...base,
      market: "nyse",
      now: etInstant("2026-10-14", 15, 30),
      minutes: [],
      priorClose: null,
      workerName: "Uriel",
    });
    expect(text).toBe("Signal prices are missing. This is not a flat day.");
  });

  it("stays quiet before the entry when the buy is already flagged", () => {
    const text = describeAssetTrigger({
      ...base,
      market: "nyse",
      now: etInstant("2026-10-14", 11, 0),
      minutes: [bar(etInstant("2026-10-14", 9, 59).getTime(), 101)],
      priorClose: 100,
      workerName: "Uriel",
    });
    expect(text).toBeNull();
  });

  it("names the pause when a flagged buy did not send", () => {
    const text = describeAssetTrigger({
      ...base,
      market: "nyse",
      now: etInstant("2026-10-14", 15, 31),
      minutes: [bar(etInstant("2026-10-14", 9, 59).getTime(), 101)],
      priorClose: 100,
      paused: true,
      workerName: "Uriel",
    });
    expect(text).toBe("Buy is flagged. No order: Uriel is paused.");
  });

  it("says a flagged buy passed with no order", () => {
    const text = describeAssetTrigger({
      ...base,
      market: "nyse",
      now: etInstant("2026-10-14", 15, 40),
      minutes: [bar(etInstant("2026-10-14", 9, 59).getTime(), 101)],
      priorClose: 100,
      workerName: "Uriel",
    });
    expect(text).toBe("Buy was flagged. No order was sent.");
  });

  it("hides the caveat once the asset has traded", () => {
    const text = describeAssetTrigger({
      ...base,
      market: "crypto",
      now: new Date("2026-10-14T23:40:00.000Z"),
      minutes: [bar(Date.parse("2026-10-14T00:00:00.000Z"), 100, 100), bar(Date.parse("2026-10-14T00:29:00.000Z"), 101)],
      priorClose: null,
      traded: true,
      workerName: "Fonzo",
    });
    expect(text).toBeNull();
  });

  it("says crypto stayed flat when the first half-hour is not up", () => {
    const text = describeAssetTrigger({
      ...base,
      market: "crypto",
      now: new Date("2026-10-14T12:00:00.000Z"),
      minutes: [bar(Date.parse("2026-10-14T00:00:00.000Z"), 100, 100), bar(Date.parse("2026-10-14T00:29:00.000Z"), 99)],
      priorClose: null,
      workerName: "Fonzo",
    });
    expect(text).toBe("Playbook trigger was not hit.");
  });

  it("says the cash market is closed", () => {
    const text = describeAssetTrigger({
      ...base,
      market: "nyse",
      now: etInstant("2026-10-17", 12, 0),
      minutes: [],
      priorClose: 100,
      workerName: "Uriel",
    });
    expect(text).toBe("Cash market is closed.");
  });

  it("ignores a size reduction and a closed-window note as the no-buy error", () => {
    expect(
      blockingReason([
        "Position size reduced to this asset 25% share of account equity.",
        "New positions are closed during the flatten.",
        "Pattern day trader limit reached.",
      ]),
    ).toBe("Pattern day trader limit reached.");
    expect(blockingReason(["Position size reduced to the cash on hand."])).toBeNull();
  });
});

describe("Nasdaq trigger caveat", () => {
  it("keeps a waiting, flat, or missing morning distinct from a flagged buy", () => {
    expect(describeNqTrigger("waiting", null)).toBe("Playbook trigger is not in yet.");
    expect(describeNqTrigger("flat", null)).toBe("Playbook trigger was not hit.");
    expect(describeNqTrigger("missing", null)).toBe("Signal prices are missing. This is not a flat day.");
    expect(describeNqTrigger("ready", null)).toBeNull();
    expect(describeNqTrigger("ready", "NQ is designated 25% of account equity, and that share cannot fund the minimum size.")).toBe(
      "Buy is flagged. No order: NQ is designated 25% of account equity, and that share cannot fund the minimum size.",
    );
    expect(describeNqTrigger("passed", null)).toBe("Buy was flagged. No order was sent.");
    expect(describeNqTrigger("passed", "Uriel is paused.")).toBe("Buy is flagged. No order: Uriel is paused.");
    expect(describeSpyTrigger("waiting", null)).toBe("Playbook trigger is not in yet.");
    expect(describeSpyTrigger("passed", null)).toBe("Buy was flagged. No order was sent.");
  });
});
