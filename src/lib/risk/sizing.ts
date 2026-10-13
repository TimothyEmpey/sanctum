import { RISK_LIMITS } from "@/lib/risk/constants";

export function riskBudgetCents(equityCents: number, fraction: number = RISK_LIMITS.maxRiskPerTrade) {
  return Math.floor(equityCents * fraction + 1e-6);
}

/**
 * position_size = floor(equity × max_risk_per_trade / abs(entry - stop))
 * The budget is floored to the cent before the share floor, so size never rounds up.
 */
export function quantityForRisk(equityCents: number, entryPrice: number, stopPrice: number, step = 1) {
  const budgetCents = riskBudgetCents(equityCents);
  const distance = Math.abs(entryPrice - stopPrice);
  if (!(distance > 0) || budgetCents <= 0 || !(entryPrice > 0) || !(step > 0)) {
    return { shares: 0, budgetCents, distance };
  }
  const raw = budgetCents / 100 / distance;
  const shares = Math.round((Math.floor((raw + 1e-9) / step) * step) * 1e8) / 1e8;
  return { shares, budgetCents, distance };
}

export function sharesForRisk(equityCents: number, entryPrice: number, stopPrice: number) {
  const budgetCents = riskBudgetCents(equityCents);
  const distance = Math.abs(entryPrice - stopPrice);
  if (!(distance > 0) || budgetCents <= 0 || !(entryPrice > 0)) {
    return { shares: 0, budgetCents, distance };
  }
  const shares = Math.floor(budgetCents / 100 / distance);
  return { shares, budgetCents, distance };
}

export function dollarRiskCents(shares: number, entryPrice: number, stopPrice: number) {
  return Math.round(shares * Math.abs(entryPrice - stopPrice) * 100);
}

export function notionalCents(shares: number, price: number) {
  return Math.round(shares * price * 100);
}

/** Cash already committed to one asset: open cost plus a working entry. */
export function deployedNotionalCents(
  trades: Array<{ symbol: string; quantity: number; entryPrice: number }>,
  orders: Array<{ symbol: string; quantity: number; limitPrice: number | null }>,
  symbol: string,
) {
  const fromTrades = trades
    .filter((trade) => trade.symbol === symbol)
    .reduce((sum, trade) => sum + notionalCents(trade.quantity, trade.entryPrice), 0);
  const fromOrders = orders
    .filter((order) => order.symbol === symbol && order.limitPrice != null)
    .reduce((sum, order) => sum + notionalCents(order.quantity, order.limitPrice ?? 0), 0);
  return fromTrades + fromOrders;
}
