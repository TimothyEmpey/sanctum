import { describe, expect, it } from "vitest";
import { etInstant } from "@/lib/market/time";
import { STRATEGY_ID } from "@/lib/risk/constants";
import {
  BROKER_CEILING_PCT,
  DISASTER_STOP_PCT,
  evaluateIntradayMomentum,
  MOMENTUM_SETUP,
  type Bar,
} from "@/lib/strategy/intraday-momentum";

function bar(date: string, hour: number, minute: number, close: number, open = close): Bar {
  return {
    ts: etInstant(date, hour, minute).getTime(),
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1_000,
  };
}

function at(
  date: string,
  hour: number,
  minute: number,
  bars: Bar[],
  overrides: Partial<Parameters<typeof evaluateIntradayMomentum>[0]> = {},
) {
  return evaluateIntradayMomentum({
    now: etInstant(date, hour, minute),
    bars,
    priorClose: 100,
    earlyClose: false,
    hasOpenPosition: false,
    tradesTaken: 0,
    ...overrides,
  });
}

const upDay = [bar("2026-10-02", 9, 59, 101), bar("2026-10-02", 15, 29, 101.4)];

describe("SPY last half-hour", () => {
  it("buys at 15:30 when the previous close to 10:00 is higher", () => {
    const view = at("2026-10-02", 15, 30, upDay);
    const proposal = view.proposal;
    expect(proposal?.setup).toBe(MOMENTUM_SETUP);
    expect(proposal?.strategy).toBe(STRATEGY_ID);
    expect(proposal?.side).toBe("LONG");
    expect(proposal!.entryPrice).toBeCloseTo(101.42, 2);
    expect(proposal!.stopPrice).toBeCloseTo(proposal!.entryPrice * (1 - DISASTER_STOP_PCT), 2);
    expect(proposal!.targetPrice).toBeCloseTo(proposal!.entryPrice * (1 + BROKER_CEILING_PCT), 2);
    expect(proposal!.stopPrice).toBeLessThan(proposal!.entryPrice);
  });

  it("uses the 9:59 close as the 10:00 price, not a later print", () => {
    const view = at("2026-10-02", 15, 30, [bar("2026-10-02", 9, 59, 99), bar("2026-10-02", 15, 29, 110)]);
    expect(view.proposal).toBeNull();
    expect(view.standDown).toMatch(/stays flat/);
  });

  it("stays flat when the first half-hour is unchanged", () => {
    const view = at("2026-10-02", 15, 30, [bar("2026-10-02", 9, 59, 100), bar("2026-10-02", 15, 29, 100.2)]);
    expect(view.proposal).toBeNull();
  });

  it("does not buy before the last half-hour", () => {
    expect(at("2026-10-02", 11, 0, upDay).proposal).toBeNull();
  });

  it("does not buy after the entry grace", () => {
    const view = at("2026-10-02", 15, 35, upDay);
    expect(view.proposal).toBeNull();
    expect(view.standDown).toMatch(/passed/);
  });

  it("buys at 12:30 on an early close", () => {
    const bars = [bar("2026-11-27", 9, 59, 101), bar("2026-11-27", 12, 29, 101.2)];
    const view = at("2026-11-27", 12, 30, bars, { earlyClose: true });
    expect(view.proposal?.setup).toBe(MOMENTUM_SETUP);
    expect(at("2026-11-27", 12, 35, bars, { earlyClose: true }).proposal).toBeNull();
  });

  it("waits when the 10:00 price or the previous close is missing", () => {
    expect(at("2026-10-02", 15, 30, [bar("2026-10-02", 15, 29, 101)]).proposal).toBeNull();
    expect(at("2026-10-02", 15, 30, upDay, { priorClose: null }).proposal).toBeNull();
  });

  it("does not add a second position or a second trade", () => {
    expect(at("2026-10-02", 15, 30, upDay, { hasOpenPosition: true }).proposal).toBeNull();
    expect(at("2026-10-02", 15, 30, upDay, { tradesTaken: 1 }).proposal).toBeNull();
  });
});
