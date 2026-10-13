/** Account guardrails. Kept exactly as specified. */
export const RISK_LIMITS = {
  maxRiskPerTrade: 0.02,
  maxDailyLoss: 0.05,
  maxWeeklyLoss: 0.05,
  maxDrawdownFromPeak: 0.05,
  maxOpenPositions: 2,
  maxTotalOpenRisk: 0.04,
  maxTradesPerDay: 1,
} as const;

export const TRADABLE_SYMBOL = "SPY";
export const PDT_EQUITY_CENTS = 2_500_000;
export const PDT_MAX_DAY_TRADES = 3;
export const PDT_WINDOW_BUSINESS_DAYS = 5;

export const STRATEGY_ID = "spy-intraday-momentum-2018";
export const STRATEGY_NAME = "SPY last half-hour, long-only";
