import { assetShareCents } from "@/lib/assets";
import { sessionClock } from "@/lib/market/calendar";
import { cryptoSessionClock } from "@/lib/market/crypto-clock";
import { PDT_EQUITY_CENTS, PDT_MAX_DAY_TRADES, RISK_LIMITS, TRADABLE_SYMBOL } from "@/lib/risk/constants";
import { dollarRiskCents, notionalCents, quantityForRisk, riskBudgetCents, sharesForRisk } from "@/lib/risk/sizing";
import type { RiskDecision, RiskState, TradeProposal } from "@/lib/risk/types";

function lossRemaining(startCents: number, pnlCents: number, limit: number) {
  return Math.floor(startCents * limit + 1e-6) + pnlCents;
}

function floorToStep(raw: number, step: number) {
  if (!(raw > 0) || !(step > 0)) return 0;
  return Math.round(Math.floor((raw + 1e-9) / step) * step * 1e8) / 1e8;
}

/**
 * Independent of the strategy. Every entry passes through here.
 * Size may be reduced to fit this asset's 25% share, cash, or remaining open-risk budget. It is never increased.
 */
export function evaluateRisk(proposal: TradeProposal, state: RiskState): RiskDecision {
  const reasons: string[] = [];
  const clock = sessionClock(proposal.now);
  const step = proposal.quantityStep ?? 1;
  const distance = Math.abs(proposal.entryPrice - proposal.stopPrice);
  const allowed = (state.allowedSymbols ?? [TRADABLE_SYMBOL]).map((symbol) => symbol.toUpperCase());
  const sized =
    step >= 1
      ? sharesForRisk(state.equityCents, proposal.entryPrice, proposal.stopPrice)
      : quantityForRisk(state.equityCents, proposal.entryPrice, proposal.stopPrice, step);
  const maxShares = sized.shares;
  const budgetCents = sized.budgetCents;
  const dayPnl = state.equityCents - state.dayStartEquityCents;
  const weekPnl = state.equityCents - state.weekStartEquityCents;
  const drawdown =
    state.peakEquityCents > 0
      ? (state.peakEquityCents - state.equityCents) / state.peakEquityCents
      : 0;

  let shares = proposal.requestedShares;

  if (!allowed.includes(proposal.symbol.toUpperCase())) {
    reasons.push(`${proposal.symbol} is untouchable. This worker cannot trade it.`);
  }
  if (!Number.isFinite(proposal.stopPrice) || distance <= 0) {
    reasons.push("Every trade must have a stop-loss before entry.");
  }
  if (proposal.side === "LONG" && !(proposal.stopPrice < proposal.entryPrice)) {
    reasons.push("Long stop must be below the entry.");
  }
  if (proposal.side === "SHORT" && !(proposal.stopPrice > proposal.entryPrice)) {
    reasons.push("Short stop must be above the entry.");
  }
  if (proposal.side === "LONG" && !(proposal.targetPrice > proposal.entryPrice)) {
    reasons.push("Long target must be above the entry.");
  }
  if (proposal.side === "SHORT" && !(proposal.targetPrice < proposal.entryPrice)) {
    reasons.push("Short target must be below the entry.");
  }
  if (proposal.side === "SHORT" && !state.shortingEnabled) {
    reasons.push("Short sales are off. The Robinhood agent path is long-only.");
  }
  const wholeShares = step >= 1;
  if (wholeShares) {
    if (!Number.isInteger(shares) || shares < 1) {
      reasons.push("Position size must be a whole number of shares.");
    }
  } else if (!(shares > 0)) {
    reasons.push("Position size must be positive.");
  }
  let heldToLastLoss = false;
  const minQty = wholeShares ? 1 : step;
  if (
    state.lastTradeWasLoss &&
    state.lastTradeShares != null &&
    state.lastTradeShares + 1e-9 >= minQty &&
    shares > state.lastTradeShares + 1e-9
  ) {
    shares = floorToStep(state.lastTradeShares, step);
    heldToLastLoss = true;
  }
  if (shares > maxShares) {
    reasons.push("Position size exceeds the risk formula.");
  }
  if (state.spyPositionOpen) {
    reasons.push(`No averaging down, and no second ${proposal.symbol} position while one is open.`);
  }
  if (state.openPositions >= RISK_LIMITS.maxOpenPositions) {
    reasons.push("Maximum open positions reached.");
  }
  if (state.tradesToday >= RISK_LIMITS.maxTradesPerDay) {
    reasons.push("Maximum trades for the day reached.");
  }
  if (state.consecutiveLosses >= 2) {
    reasons.push("Revenge-trading lockout after two consecutive losses.");
  }
  if (state.agentPaused) reasons.push(proposal.market === "crypto" ? "Fonzo is paused." : "Uriel is paused.");
  if (state.haltReason) reasons.push(`Trading halted: ${state.haltReason}`);
  const windowOpen = proposal.market === "crypto" ? cryptoSessionClock(proposal.now).entryWindowOpen : clock.entryWindowOpen;
  const phaseLabel = proposal.market === "crypto" ? cryptoSessionClock(proposal.now).phase : clock.phase;
  if (!windowOpen) reasons.push(`New positions are closed during ${phaseLabel}.`);
  if (dayPnl <= -riskBudgetCents(state.dayStartEquityCents, RISK_LIMITS.maxDailyLoss)) {
    reasons.push("Daily loss limit reached. No new positions.");
  }
  if (weekPnl <= -riskBudgetCents(state.weekStartEquityCents, RISK_LIMITS.maxWeeklyLoss)) {
    reasons.push("Weekly loss limit reached.");
  }
  if (drawdown >= RISK_LIMITS.maxDrawdownFromPeak - 1e-12) {
    reasons.push("Drawdown from peak equity reached 5.0%.");
  }
  if (proposal.market !== "crypto" && state.equityCents < PDT_EQUITY_CENTS && state.dayTradesInPdtWindow >= PDT_MAX_DAY_TRADES) {
    reasons.push("Pattern day trader limit: 3 day trades in 5 business days under $25,000.");
  }

  const hardReject = reasons.length > 0;

  if (!hardReject) {
    const openRoomCents = Math.max(
      0,
      riskBudgetCents(state.equityCents, RISK_LIMITS.maxTotalOpenRisk) - state.openRiskCents,
    );
    const byOpenRisk = distance > 0 ? floorToStep(openRoomCents / 100 / distance, step) : 0;
    const byCash =
      proposal.side === "LONG" && proposal.entryPrice > 0
        ? floorToStep(state.cashCents / 100 / proposal.entryPrice, step)
        : shares;
    const shareRoomCents = Math.max(0, assetShareCents(state.equityCents) - (state.sleeveUsedCents ?? 0));
    const byShare =
      proposal.entryPrice > 0 ? floorToStep(shareRoomCents / 100 / proposal.entryPrice, step) : 0;
    const fitted = Math.min(shares, maxShares, byOpenRisk, byCash, byShare);
    const shareBinds = byShare + 1e-9 < Math.min(shares, maxShares, byOpenRisk, byCash);
    if (fitted + 1e-9 < minQty) {
      reasons.push(
        byShare + 1e-9 < minQty
          ? `${proposal.symbol} is designated 25% of account equity, and that share cannot fund the minimum size.`
          : wholeShares
            ? "Available cash or open-risk budget cannot fund one share."
            : "Available cash or open-risk budget cannot fund the minimum quantity.",
      );
    } else if (fitted + 1e-9 < shares) {
      shares = fitted;
      reasons.push(
        shareBinds
          ? "Position size reduced to this asset 25% share of account equity."
          : "Position size reduced to the cash and open-risk budget.",
      );
    } else {
      shares = fitted;
    }
    if (heldToLastLoss) reasons.push("Position size reduced to the previous losing trade.");
  }

  const riskCents = dollarRiskCents(Math.max(shares, 0), proposal.entryPrice, proposal.stopPrice);
  if (!hardReject && shares + 1e-9 >= minQty && riskCents > budgetCents) {
    reasons.push("Dollar risk exceeds 2% of equity.");
  }

  const blocking = reasons.filter((reason) => !reason.startsWith("Position size reduced"));
  const approved = blocking.length === 0 && shares + 1e-9 >= minQty;

  return {
    approved,
    shares: approved ? shares : 0,
    riskCents: approved ? dollarRiskCents(shares, proposal.entryPrice, proposal.stopPrice) : 0,
    reasons: approved && reasons.length === 0 ? ["Approved."] : reasons,
    computed: {
      maxShares,
      riskBudgetCents: budgetCents,
      stopDistance: distance,
      openRiskAfterCents: state.openRiskCents + (approved ? dollarRiskCents(shares, proposal.entryPrice, proposal.stopPrice) : 0),
      dailyLossRemainingCents: lossRemaining(state.dayStartEquityCents, dayPnl, RISK_LIMITS.maxDailyLoss),
      weeklyLossRemainingCents: lossRemaining(state.weekStartEquityCents, weekPnl, RISK_LIMITS.maxWeeklyLoss),
      drawdown,
      notionalCents: approved ? notionalCents(shares, proposal.entryPrice) : 0,
    },
  };
}

export function haltReasonForState(state: Pick<
  RiskState,
  "equityCents" | "peakEquityCents" | "dayStartEquityCents" | "weekStartEquityCents"
>) {
  const dayPnl = state.equityCents - state.dayStartEquityCents;
  const weekPnl = state.equityCents - state.weekStartEquityCents;
  const drawdown =
    state.peakEquityCents > 0
      ? (state.peakEquityCents - state.equityCents) / state.peakEquityCents
      : 0;
  if (dayPnl <= -riskBudgetCents(state.dayStartEquityCents, RISK_LIMITS.maxDailyLoss)) {
    return "Daily loss limit reached.";
  }
  if (weekPnl <= -riskBudgetCents(state.weekStartEquityCents, RISK_LIMITS.maxWeeklyLoss)) {
    return "Weekly loss limit reached.";
  }
  if (drawdown >= RISK_LIMITS.maxDrawdownFromPeak - 1e-12) {
    return "Drawdown from peak reached 5.0%.";
  }
  return null;
}
