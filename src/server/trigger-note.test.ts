import { describe, expect, it } from "vitest";
import { sessionRiskReasons } from "@/server/trigger-note";

describe("session risk reasons", () => {
  const now = new Date("2026-10-14T19:40:00.000Z");

  it("uses the newest decision for that asset and session", () => {
    const reasons = sessionRiskReasons(
      [
        { approved: true, proposal: { symbol: "QQQ" }, reasons: [], createdAt: now },
        { approved: false, proposal: { symbol: "QQQ" }, reasons: ["Daily loss limit reached."], createdAt: new Date("2026-10-14T19:30:00.000Z") },
      ],
      "QQQ",
      "2026-10-14",
      "nyse",
    );
    expect(reasons).toBeNull();
  });

  it("treats a decision with no symbol as SPY", () => {
    const reasons = sessionRiskReasons(
      [{ approved: false, proposal: {}, reasons: ["Uriel is paused."], createdAt: now }],
      "SPY",
      "2026-10-14",
      "nyse",
    );
    expect(reasons).toEqual(["Uriel is paused."]);
    expect(
      sessionRiskReasons([{ approved: false, proposal: {}, reasons: ["Uriel is paused."], createdAt: now }], "QQQ", "2026-10-14", "nyse"),
    ).toBeNull();
  });
});
