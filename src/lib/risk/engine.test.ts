import { describe, expect, it } from "vitest";
import { nextSessionWake, nextTopOfHourEt, sessionClock, workerWaitMs } from "@/lib/market/calendar";
import { fiveMinuteCandles, isStrategyBar } from "@/lib/market/bars";
import { etInstant } from "@/lib/market/time";
import { assertAgentExit, assertTradableSymbol } from "@/lib/broker/firewall";
import { aggregateEquity } from "@/lib/portfolio/equity";
import { sameDesk } from "@/lib/assets";
import { evaluateRisk } from "@/lib/risk/engine";
import { deployedNotionalCents, quantityForRisk, sharesForRisk } from "@/lib/risk/sizing";
import { stopChangeAllowed } from "@/lib/risk/stops";
import type { RiskState, TradeProposal } from "@/lib/risk/types";
import { evaluateOrb, type Bar } from "@/lib/strategy/orb";

const NOW = etInstant("2026-10-02", 15, 30);

function state(overrides: Partial<RiskState> = {}): RiskState {
  return {
    equityCents: 5_000_000,
    cashCents: 40_000_000,
    peakEquityCents: 5_000_000,
    dayStartEquityCents: 5_000_000,
    weekStartEquityCents: 5_000_000,
    openPositions: 0,
    openRiskCents: 0,
    tradesToday: 0,
    consecutiveLosses: 0,
    lastTradeWasLoss: false,
    lastTradeShares: null,
    agentPaused: false,
    haltReason: null,
    spyPositionOpen: false,
    shortingEnabled: false,
    ...overrides,
  };
}

function proposal(overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    symbol: "SPY",
    side: "LONG",
    entryPrice: 500,
    stopPrice: 498,
    targetPrice: 503,
    requestedShares: 500,
    setup: "ORB_LONG",
    now: NOW,
    ...overrides,
  };
}

describe("position sizing", () => {
  it("floors shares from 2% of equity and the stop distance", () => {
    const sized = sharesForRisk(5_000_000, 500, 498);
    expect(sized.budgetCents).toBe(100_000);
    expect(sized.shares).toBe(500);
  });

  it("counts only this asset's open cost and working entry", () => {
    const used = deployedNotionalCents(
      [{ symbol: "NQ", quantity: 1, entryPrice: 100 }],
      [
        { symbol: "NQ", quantity: 1, limitPrice: 100 },
        { symbol: "SPY", quantity: 1, limitPrice: 500 },
      ],
      "NQ",
    );
    expect(used).toBe(20_000);
  });

  it("floors a crypto quantity to the exchange step", () => {
    const sized = quantityForRisk(100_000, 100_000, 98_000, 0.0001);
    expect(sized.budgetCents).toBe(2_000);
    expect(sized.shares).toBeCloseTo(0.01, 8);
  });
});

describe("risk engine", () => {
  it("approves a sized SPY long with a stop", () => {
    const decision = evaluateRisk(
      proposal(),
      state({
        equityCents: 100_000_000,
        cashCents: 100_000_000,
        peakEquityCents: 100_000_000,
        dayStartEquityCents: 100_000_000,
        weekStartEquityCents: 100_000_000,
      }),
    );
    expect(decision.approved).toBe(true);
    expect(decision.shares).toBe(500);
    expect(decision.riskCents).toBe(100_000);
  });

  it("rejects size above the formula instead of rounding up", () => {
    const decision = evaluateRisk(proposal({ requestedShares: 501 }), state());
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/exceeds the risk formula/);
  });

  it("reduces size to available cash", () => {
    const decision = evaluateRisk(proposal(), state({ equityCents: 40_000_000, cashCents: 5_000_000 }));
    expect(decision.approved).toBe(true);
    expect(decision.shares).toBe(100);
    expect(decision.reasons.join(" ")).toMatch(/reduced/);
  });

  it("blocks every symbol other than SPY", () => {
    const decision = evaluateRisk(proposal({ symbol: "AAPL" }), state());
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/untouchable/);
  });

  it("requires a stop on the correct side of entry", () => {
    expect(evaluateRisk(proposal({ stopPrice: 500 }), state()).approved).toBe(false);
    expect(evaluateRisk(proposal({ stopPrice: 501 }), state()).approved).toBe(false);
  });

  it("halts new risk at the daily, weekly, and peak limits", () => {
    expect(
      evaluateRisk(proposal(), state({ equityCents: 4_750_000 })).approved,
    ).toBe(false);
    expect(
      evaluateRisk(
        proposal(),
        state({ equityCents: 4_750_000, peakEquityCents: 4_750_000, dayStartEquityCents: 5_000_000 }),
      ).reasons.join(" "),
    ).toMatch(/Daily loss/);
    expect(
      evaluateRisk(
        proposal(),
        state({
          equityCents: 4_750_000,
          peakEquityCents: 4_750_000,
          dayStartEquityCents: 4_750_000,
          weekStartEquityCents: 5_000_000,
        }),
      ).reasons.join(" "),
    ).toMatch(/Weekly loss/);
  });

  it("keeps the numeric guardrails", () => {
    expect(evaluateRisk(proposal(), state({ tradesToday: 3 })).approved).toBe(false);
    expect(evaluateRisk(proposal(), state({ openPositions: 2 })).approved).toBe(false);
    expect(evaluateRisk(proposal(), state({ spyPositionOpen: true })).approved).toBe(false);
    expect(evaluateRisk(proposal(), state({ consecutiveLosses: 2 })).approved).toBe(false);
    const afterLoss = evaluateRisk(proposal({ requestedShares: 40 }), state({ lastTradeWasLoss: true, lastTradeShares: 20 }));
    expect(afterLoss.approved).toBe(true);
    expect(afterLoss.shares).toBe(20);
    expect(evaluateRisk(proposal(), state({ agentPaused: true })).approved).toBe(false);
  });

  it("blocks shorts unless shorting is explicitly enabled", () => {
    const short = proposal({
      side: "SHORT",
      entryPrice: 500,
      stopPrice: 502,
      targetPrice: 497,
    });
    expect(evaluateRisk(short, state()).approved).toBe(false);
    expect(evaluateRisk(short, state({ shortingEnabled: true })).approved).toBe(true);
  });

  it("does not apply a $25,000 day-trade cap to a later SPY structure", () => {
    const decision = evaluateRisk(
      proposal({
        setup: "SPY_STRUCTURE",
        now: etInstant("2026-10-02", 11, 0),
        entryPrice: 100,
        stopPrice: 98,
        targetPrice: 103,
        requestedShares: 0.2,
        quantityStep: 0.001,
      }),
      state({
        equityCents: 100_000,
        cashCents: 100_000,
        peakEquityCents: 100_000,
        dayStartEquityCents: 100_000,
        weekStartEquityCents: 100_000,
        tradesToday: 4,
        consecutiveLosses: 2,
        lastTradeWasLoss: true,
        lastTradeShares: 0.01,
        allowedSymbols: ["SPY", "NQ"],
      }),
    );
    expect(decision.approved).toBe(true);
    expect(decision.shares).toBe(0.2);
    expect(decision.reasons.join(" ")).not.toMatch(/Pattern day trader|day-trade|trades for the day|lockout/);
  });

  it("counts Uriel and Fonzo as separate desks", () => {
    expect(sameDesk("SPY", "NQ")).toBe(true);
    expect(sameDesk("BTC/USD", "ETH/USD")).toBe(true);
    expect(sameDesk("SPY", "BTC/USD")).toBe(false);
    expect(sameDesk("NQ", "ETH/USD")).toBe(false);
  });

  it("allows NQ only for the stock worker", () => {
    const morning = etInstant("2026-10-02", 10, 2);
    expect(evaluateRisk(proposal({ symbol: "NQ", setup: "NQ_SWEEP", now: morning }), state()).approved).toBe(false);
    const decision = evaluateRisk(
      proposal({ symbol: "NQ", setup: "NQ_SWEEP", now: morning }),
      state({
        allowedSymbols: ["SPY", "NQ"],
        equityCents: 100_000_000,
        cashCents: 100_000_000,
        peakEquityCents: 100_000_000,
        dayStartEquityCents: 100_000_000,
        weekStartEquityCents: 100_000_000,
      }),
    );
    expect(decision.approved).toBe(true);
    expect(decision.shares).toBe(500);
  });

  it("approves a fractional crypto buy during the UTC window even after three stock day trades", () => {
    const decision = evaluateRisk(
      proposal({
        symbol: "BTC/USD",
        entryPrice: 100_000,
        stopPrice: 98_000,
        targetPrice: 105_000,
        requestedShares: 0.01,
        setup: "CRYPTO_LAST_HALF",
        now: new Date("2026-10-02T23:30:00.000Z"),
        market: "crypto",
        quantityStep: 0.0001,
      }),
      state({
        equityCents: 100_000,
        cashCents: 100_000,
        peakEquityCents: 100_000,
        dayStartEquityCents: 100_000,
        weekStartEquityCents: 100_000,
        allowedSymbols: ["BTC/USD", "ETH/USD"],
      }),
    );
    expect(decision.approved).toBe(true);
    expect(decision.shares).toBeCloseTo(0.0025, 8);
    expect(decision.reasons.join(" ")).toMatch(/25%/);
    const paused = evaluateRisk(
      proposal({
        symbol: "ETH/USD",
        entryPrice: 4_000,
        stopPrice: 3_920,
        targetPrice: 4_200,
        requestedShares: 0.25,
        now: new Date("2026-10-02T23:30:00.000Z"),
        market: "crypto",
        quantityStep: 0.0001,
      }),
      state({ equityCents: 100_000, cashCents: 100_000, agentPaused: true, allowedSymbols: ["BTC/USD", "ETH/USD"] }),
    );
    expect(paused.approved).toBe(false);
    expect(paused.reasons.join(" ")).toMatch(/Fonzo is paused/);
  });

  it("keeps each asset inside its quarter of account equity", () => {
    const book = {
      equityCents: 100_000,
      cashCents: 100_000,
      peakEquityCents: 100_000,
      dayStartEquityCents: 100_000,
      weekStartEquityCents: 100_000,
      allowedSymbols: ["SPY", "NQ"],
    };
    const spy = evaluateRisk(
      proposal({ entryPrice: 778, stopPrice: 762.44, targetPrice: 816.9, requestedShares: 1 }),
      state(book),
    );
    expect(spy.approved).toBe(false);
    expect(spy.reasons.join(" ")).toMatch(/25%/);
    const used = evaluateRisk(
      proposal({
        symbol: "NQ",
        setup: "NQ_SWEEP",
        now: etInstant("2026-10-02", 10, 2),
        entryPrice: 40,
        stopPrice: 39,
        targetPrice: 42,
        requestedShares: 4,
      }),
      state({ ...book, sleeveUsedCents: 20_000 }),
    );
    expect(used.approved).toBe(true);
    expect(used.shares).toBe(1);
    expect(used.computed.notionalCents).toBeLessThanOrEqual(5_000);
    expect(used.reasons.join(" ")).toMatch(/25%/);
  });

  it("keeps the Nasdaq buy on its morning window", () => {
    const book = {
      equityCents: 100_000,
      cashCents: 100_000,
      peakEquityCents: 100_000,
      dayStartEquityCents: 100_000,
      weekStartEquityCents: 100_000,
      allowedSymbols: ["SPY", "NQ"],
    };
    const morning = etInstant("2026-10-02", 10, 2);
    const nq = evaluateRisk(
      proposal({
        symbol: "NQ",
        setup: "NQ_SWEEP",
        now: morning,
        entryPrice: 40,
        stopPrice: 39,
        targetPrice: 42,
        requestedShares: 1,
      }),
      state(book),
    );
    expect(nq.reasons.join(" ")).not.toMatch(/New positions are closed/);
    const spy = evaluateRisk(proposal({ now: morning }), state({ allowedSymbols: ["SPY", "NQ"] }));
    expect(spy.approved).toBe(false);
    expect(spy.reasons.join(" ")).toMatch(/New positions are closed/);
    const late = evaluateRisk(
      proposal({
        symbol: "NQ",
        setup: "NQ_SWEEP",
        now: etInstant("2026-10-02", 15, 30),
        entryPrice: 40,
        stopPrice: 39,
        targetPrice: 42,
        requestedShares: 1,
      }),
      state(book),
    );
    expect(late.approved).toBe(false);
    expect(late.reasons.join(" ")).toMatch(/New positions are closed/);
  });

  it("lets a fractional SPY structure buy use the morning and the 25% share", () => {
    const decision = evaluateRisk(
      proposal({
        symbol: "SPY",
        setup: "SPY_STRUCTURE",
        now: etInstant("2026-10-02", 10, 46),
        entryPrice: 770,
        stopPrice: 768,
        targetPrice: 774,
        requestedShares: 10,
        quantityStep: 0.001,
      }),
      state({
        equityCents: 100_000,
        cashCents: 100_000,
        peakEquityCents: 100_000,
        dayStartEquityCents: 100_000,
        weekStartEquityCents: 100_000,
        allowedSymbols: ["SPY", "NQ"],
      }),
    );
    expect(decision.approved).toBe(true);
    expect(decision.shares).toBeGreaterThan(0);
    expect(decision.shares).toBeLessThan(1);
    expect(decision.computed.notionalCents).toBeLessThanOrEqual(25_000);
    expect(decision.reasons.join(" ")).toMatch(/25%/);
    expect(decision.reasons.join(" ")).not.toMatch(/New positions are closed/);
    const shut = evaluateRisk(
      proposal({
        symbol: "SPY",
        setup: "SPY_STRUCTURE",
        now: etInstant("2026-10-02", 15, 59),
        entryPrice: 770,
        stopPrice: 768,
        targetPrice: 774,
        requestedShares: 0.2,
        quantityStep: 0.001,
      }),
      state({
        equityCents: 100_000,
        cashCents: 100_000,
        peakEquityCents: 100_000,
        dayStartEquityCents: 100_000,
        weekStartEquityCents: 100_000,
        allowedSymbols: ["SPY", "NQ"],
      }),
    );
    expect(shut.approved).toBe(false);
    expect(shut.reasons.join(" ")).toMatch(/New positions are closed/);
  });

  it("refuses one Nasdaq contract when the 25% share cannot pay for it", () => {
    const decision = evaluateRisk(
      proposal({
        symbol: "NQ",
        setup: "NQ_SWEEP",
        now: etInstant("2026-10-02", 10, 2),
        entryPrice: 30_028,
        stopPrice: 30_018,
        targetPrice: 30_100,
        requestedShares: 1,
      }),
      state({
        equityCents: 100_000,
        cashCents: 100_000,
        peakEquityCents: 100_000,
        dayStartEquityCents: 100_000,
        weekStartEquityCents: 100_000,
        allowedSymbols: ["SPY", "NQ"],
      }),
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/25%/);
  });

  it("refuses entries outside the window", () => {
    const decision = evaluateRisk(proposal({ now: etInstant("2026-10-03", 11, 0) }), state());
    expect(decision.approved).toBe(false);
    expect(evaluateRisk(proposal({ now: etInstant("2026-10-02", 10, 0) }), state()).approved).toBe(false);
    expect(evaluateRisk(proposal({ now: etInstant("2026-10-02", 15, 36) }), state()).approved).toBe(false);
  });
});

describe("stops", () => {
  it("allows a tighter stop and rejects a wider one", () => {
    expect(stopChangeAllowed("LONG", 500, 498, 499).ok).toBe(true);
    expect(stopChangeAllowed("LONG", 500, 498, 497).ok).toBe(false);
    expect(stopChangeAllowed("SHORT", 500, 502, 501).ok).toBe(true);
    expect(stopChangeAllowed("SHORT", 500, 502, 503).ok).toBe(false);
  });
});

describe("firewall", () => {
  it("refuses exits that would sell reserved shares", () => {
    expect(() => assertTradableSymbol("MSFT")).toThrow(/untouchable/);
    expect(() =>
      assertAgentExit({ symbol: "SPY", quantity: 12, agentQuantity: 8, baselineQuantity: 10 }),
    ).toThrow(/baseline/);
    expect(() =>
      assertAgentExit({ symbol: "SPY", quantity: 8, agentQuantity: 8, baselineQuantity: 10 }),
    ).not.toThrow();
    expect(() => assertAgentExit({ symbol: "NQ", quantity: 1.5, agentQuantity: 2, baselineQuantity: 0 })).toThrow(/whole number/);
    expect(() => assertAgentExit({ symbol: "SPY", quantity: 0.25, agentQuantity: 0.25, baselineQuantity: 0 })).not.toThrow();
    expect(() => assertAgentExit({ symbol: "BTC/USD", quantity: 0.01, agentQuantity: 0.01, baselineQuantity: 0 })).not.toThrow();
  });
});

describe("calendar", () => {
  it("keeps the 2026 NYSE schedule", () => {
    expect(sessionClock(etInstant("2026-11-26", 10, 0)).phase).toBe("closed");
    expect(sessionClock(etInstant("2026-10-03", 10, 0)).phase).toBe("closed");
    expect(sessionClock(etInstant("2026-10-02", 9, 40)).phase).toBe("opening_range");
    expect(sessionClock(etInstant("2026-10-02", 10, 0)).phase).toBe("manage");
    expect(sessionClock(etInstant("2026-10-02", 10, 0)).entryWindowOpen).toBe(false);
    expect(sessionClock(etInstant("2026-10-02", 10, 0)).label).toBe("Cash session");
    expect(sessionClock(etInstant("2026-10-02", 15, 30)).phase).toBe("entry");
    expect(sessionClock(etInstant("2026-10-02", 15, 30)).entryWindowOpen).toBe(true);
    expect(sessionClock(etInstant("2026-10-02", 15, 35)).phase).toBe("manage");
    expect(sessionClock(etInstant("2026-10-02", 15, 55)).phase).toBe("manage");
    expect(sessionClock(etInstant("2026-10-02", 15, 59)).phase).toBe("flatten");
    expect(sessionClock(etInstant("2026-11-27", 12, 30)).entryWindowOpen).toBe(true);
    expect(sessionClock(etInstant("2026-11-27", 12, 55)).phase).toBe("manage");
    expect(sessionClock(etInstant("2026-11-27", 12, 59)).phase).toBe("flatten");
    expect(sessionClock(etInstant("2026-11-27", 10, 0)).entryWindowOpen).toBe(false);
  });

  it("heartbeats on the ET hour while the market is closed, and wakes at 9:25", () => {
    const saturday = etInstant("2026-10-03", 10, 17);
    expect(etPartsOf(nextTopOfHourEt(saturday))).toEqual({ dateKey: "2026-10-03", hour: 11, minute: 0 });
    expect(workerWaitMs(saturday)).toBe(nextTopOfHourEt(saturday).getTime() - saturday.getTime());

    const onTheHour = etInstant("2026-10-03", 10, 0);
    expect(etPartsOf(nextTopOfHourEt(onTheHour))).toEqual({ dateKey: "2026-10-03", hour: 11, minute: 0 });

    const overnight = etInstant("2026-10-05", 9, 0);
    expect(etPartsOf(nextSessionWake(overnight))).toEqual({ dateKey: "2026-10-05", hour: 9, minute: 25 });
    expect(workerWaitMs(overnight)).toBe(nextSessionWake(overnight).getTime() - overnight.getTime());

    expect(workerWaitMs(etInstant("2026-10-05", 10, 0), 0)).toBe(20_000);
  });

  it("keeps daily prints out of the opening range", () => {
    expect(isStrategyBar("1m")).toBe(true);
    expect(isStrategyBar("1d")).toBe(false);
  });

  it("builds 5-minute candles from one-minute prints", () => {
    const base = etInstant("2026-10-05", 9, 30).getTime();
    const candles = fiveMinuteCandles([
      { t: base, open: 10, high: 11, low: 9.5, close: 10.5, volume: 100 },
      { t: base + 60_000, open: 10.5, high: 12, low: 10, close: 11.5, volume: 50 },
      { t: base + 5 * 60_000, open: 11.5, high: 11.8, low: 11, close: 11.2, volume: 80 },
    ]);
    expect(candles).toEqual([
      { t: base, open: 10, high: 12, low: 9.5, close: 11.5, volume: 150 },
      { t: base + 5 * 60_000, open: 11.5, high: 11.8, low: 11, close: 11.2, volume: 80 },
    ]);
  });
});

function etPartsOf(date: Date) {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => formatted.find((part) => part.type === type)?.value ?? "";
  let hour = Number(pick("hour"));
  if (hour === 24) hour = 0;
  return {
    dateKey: `${pick("year")}-${pick("month")}-${pick("day")}`,
    hour,
    minute: Number(pick("minute")),
  };
}

function minute(dateKey: string, hour: number, minuteOfHour: number, close: number, volume: number, low: number, high: number): Bar {
  return {
    ts: etInstant(dateKey, hour, minuteOfHour).getTime(),
    open: close,
    high,
    low,
    close,
    volume,
  };
}

function span(dateKey: string, from: number, to: number, close: number, volume: number, low: number, high: number) {
  const bars: Bar[] = [];
  for (let minuteOfDay = from; minuteOfDay < to; minuteOfDay += 1) {
    bars.push(minute(dateKey, Math.floor(minuteOfDay / 60), minuteOfDay % 60, close, volume, low, high));
  }
  return bars;
}

function sessionBars(dateKey: string): Bar[] {
  const bars: Bar[] = [];
  for (let minuteOfDay = 9 * 60 + 30; minuteOfDay < 9 * 60 + 45; minuteOfDay += 1) {
    const price = minuteOfDay < 9 * 60 + 35 ? 99.8 : minuteOfDay < 9 * 60 + 40 ? 99.95 : 100;
    bars.push(
      minute(dateKey, Math.floor(minuteOfDay / 60), minuteOfDay % 60, price, 1_000, 99.7, 100.1),
    );
  }
  for (let minuteOfDay = 9 * 60 + 45; minuteOfDay < 9 * 60 + 50; minuteOfDay += 1) {
    bars.push(minute(dateKey, 9, minuteOfDay % 60, 100.4, 1_800, 100.2, 100.55));
  }
  return bars;
}

describe("SPY opening range", () => {
  it("proposes one long when the 5-minute close clears the range on volume and VWAP", () => {
    const decision = evaluateOrb({
      now: etInstant("2026-10-02", 9, 50),
      bars: sessionBars("2026-10-02"),
      hasOpenPosition: false,
      tradesTaken: 0,
      consecutiveLosses: 0,
      longStopped: false,
    });
    expect(decision.proposal?.side).toBe("LONG");
    expect(decision.proposal?.symbol).toBe("SPY");
    expect(decision.proposal!.stopPrice).toBeLessThan(decision.proposal!.entryPrice);
    expect(decision.proposal!.targetPrice).toBeGreaterThan(decision.proposal!.entryPrice);
  });

  it("does not trade while the opening range is forming", () => {
    const decision = evaluateOrb({
      now: etInstant("2026-10-02", 9, 40),
      bars: sessionBars("2026-10-02"),
      hasOpenPosition: false,
      tradesTaken: 0,
      consecutiveLosses: 0,
      longStopped: false,
    });
    expect(decision.proposal).toBeNull();
  });

  it("takes a later fresh cross after price falls back under the range", () => {
    const bars = [
      ...sessionBars("2026-10-02"),
      ...span("2026-10-02", 9 * 60 + 50, 9 * 60 + 55, 100, 1_000, 99.9, 100.05),
      ...span("2026-10-02", 10 * 60, 10 * 60 + 5, 100.5, 1_800, 100.3, 100.6),
    ];
    const decision = evaluateOrb({
      now: etInstant("2026-10-02", 10, 5),
      bars,
      hasOpenPosition: false,
      tradesTaken: 1,
      consecutiveLosses: 0,
      longStopped: false,
    });
    expect(decision.proposal?.side).toBe("LONG");
    expect(decision.proposal?.signalBarTs).toBe(etInstant("2026-10-02", 10, 4).getTime());
  });

  it("does not chase the original cross once it is older than 10 minutes", () => {
    const bars = [
      ...sessionBars("2026-10-02"),
      ...span("2026-10-02", 9 * 60 + 50, 10 * 60 + 5, 100.4, 1_800, 100.2, 100.55),
    ];
    const decision = evaluateOrb({
      now: etInstant("2026-10-02", 10, 5),
      bars,
      hasOpenPosition: false,
      tradesTaken: 0,
      consecutiveLosses: 0,
      longStopped: false,
    });
    expect(decision.proposal).toBeNull();
    expect(decision.note).toMatch(/stale/i);
  });

  it("stands down when the opening range is an event bar", () => {
    const bars = sessionBars("2026-10-02").map((bar) =>
      etPartsMinutes(bar) < 9 * 60 + 45 ? { ...bar, high: 102, low: 99 } : bar,
    );
    const decision = evaluateOrb({
      now: etInstant("2026-10-02", 9, 50),
      bars,
      hasOpenPosition: false,
      tradesTaken: 0,
      consecutiveLosses: 0,
      longStopped: false,
    });
    expect(decision.proposal).toBeNull();
    expect(decision.standDown).toMatch(/wide|event/i);
  });
});

function etPartsMinutes(bar: Bar) {
  const date = new Date(bar.ts);
  return date.getTime() ? requireMinutes(date) : 0;
}

function requireMinutes(date: Date) {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(formatted.find((part) => part.type === "hour")?.value);
  const minute = Number(formatted.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

describe("equity aggregation", () => {
  it("keeps the last point in each bucket", () => {
    const now = Date.UTC(2026, 9, 2, 20, 0, 0);
    const points = [
      { t: now - 3 * 60 * 60 * 1000, equityCents: 100 },
      { t: now - 3 * 60 * 60 * 1000 + 10 * 60 * 1000, equityCents: 110 },
      { t: now - 30 * 60 * 1000, equityCents: 140 },
    ];
    const hourly = aggregateEquity(points, "hour", now);
    expect(hourly.map((point) => point.equityCents)).toEqual([110, 140]);
  });

  it("draws a year view from monthly marks inside one calendar year", () => {
    const now = Date.UTC(2026, 9, 2, 20, 0, 0);
    const points = [
      { t: Date.UTC(2026, 6, 6, 20), equityCents: 100 },
      { t: Date.UTC(2026, 7, 6, 20), equityCents: 120 },
      { t: Date.UTC(2026, 8, 6, 20), equityCents: 110 },
      { t: Date.UTC(2026, 9, 2, 20), equityCents: 140 },
    ];
    const yearly = aggregateEquity(points, "year", now);
    expect(yearly.map((point) => point.equityCents)).toEqual([100, 120, 110, 140]);
  });
});
