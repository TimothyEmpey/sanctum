export type Side = "LONG" | "SHORT";

export type TradeProposal = {
  symbol: string;
  side: Side;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  requestedShares: number;
  setup: string;
  now: Date;
  /** Crypto uses the UTC session. Stocks stay on the NYSE clock. */
  market?: "nyse" | "crypto";
  /** 1 for a whole share. Robinhood fractions use 0.000001. Crypto uses 0.0001. */
  quantityStep?: number;
};

export type RiskState = {
  equityCents: number;
  cashCents: number;
  /** Notional already committed to this symbol. The rest of its 25% share is still free. */
  sleeveUsedCents?: number;
  peakEquityCents: number;
  dayStartEquityCents: number;
  weekStartEquityCents: number;
  openPositions: number;
  openRiskCents: number;
  tradesToday: number;
  consecutiveLosses: number;
  lastTradeWasLoss: boolean;
  lastTradeShares: number | null;
  agentPaused: boolean;
  haltReason: string | null;
  spyPositionOpen: boolean;
  shortingEnabled: boolean;
  /** Defaults to SPY when omitted, so a stray proposal cannot reach another symbol. */
  allowedSymbols?: string[];
};

export type RiskDecision = {
  approved: boolean;
  shares: number;
  riskCents: number;
  reasons: string[];
  computed: {
    maxShares: number;
    riskBudgetCents: number;
    stopDistance: number;
    openRiskAfterCents: number;
    dailyLossRemainingCents: number;
    weeklyLossRemainingCents: number;
    drawdown: number;
    notionalCents: number;
  };
};
