export type ClosedPnl = {
  origin: string;
  status: string;
  realizedPnlCents: number;
  rMultiple: number | null;
  closedAt: string | null;
  openedAt: string;
};

export function engineClosed<T extends { origin: string; status: string }>(trades: T[]) {
  return trades.filter((trade) => trade.status === "CLOSED" && trade.origin === "ENGINE");
}

export function sampleClosed<T extends { origin: string; status: string }>(trades: T[]) {
  return trades.filter((trade) => trade.status === "CLOSED" && trade.origin !== "ENGINE");
}

export type SplitSide = "LONG" | "SHORT";

export type SplitTrade = {
  assetClass: "stocks" | "crypto";
  origin: string;
  status: string;
  side: SplitSide;
  quantity: number;
  entryPrice: number;
  exitPrice: number | null;
  realizedPnlCents: number;
  openedAtMs: number;
  closedAtMs: number | null;
  mark: number | null;
  markAtStart: number | null;
};

export function signedMoveCents(side: SplitSide, quantity: number, from: number, to: number) {
  const sign = side === "LONG" ? 1 : -1;
  return Math.round((to - from) * quantity * sign * 100);
}

/** One trade's share of the book P&L since windowStartMs. A position opened earlier counts only the move after that instant. */
export function tradeWindowCents(trade: SplitTrade, windowStartMs: number) {
  if (trade.origin !== "ENGINE") return 0;
  if (trade.status !== "OPEN" && trade.status !== "CLOSED") return 0;
  if (trade.status === "CLOSED" && (trade.closedAtMs == null || trade.closedAtMs < windowStartMs)) return 0;
  if (trade.openedAtMs >= windowStartMs) {
    if (trade.status === "CLOSED") return trade.realizedPnlCents;
    return signedMoveCents(trade.side, trade.quantity, trade.entryPrice, trade.mark ?? trade.entryPrice);
  }
  const basis = trade.markAtStart ?? trade.entryPrice;
  if (trade.status === "CLOSED") {
    return signedMoveCents(trade.side, trade.quantity, basis, trade.exitPrice ?? trade.entryPrice);
  }
  return signedMoveCents(trade.side, trade.quantity, basis, trade.mark ?? trade.entryPrice);
}

export function splitPnl(trades: SplitTrade[], windowStartMs: number) {
  let stocks = 0;
  let crypto = 0;
  for (const trade of trades) {
    const cents = tradeWindowCents(trade, windowStartMs);
    if (trade.assetClass === "crypto") crypto += cents;
    else stocks += cents;
  }
  return { stocks, crypto };
}

export function summarizeRealized(trades: Pick<ClosedPnl, "realizedPnlCents" | "rMultiple">[]) {
  const wins = trades.filter((trade) => trade.realizedPnlCents > 0);
  const losses = trades.filter((trade) => trade.realizedPnlCents < 0);
  const realized = trades.reduce((sum, trade) => sum + trade.realizedPnlCents, 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.realizedPnlCents, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.realizedPnlCents, 0));
  const avgR = trades.length === 0 ? 0 : trades.reduce((sum, trade) => sum + (trade.rMultiple ?? 0), 0) / trades.length;
  return {
    count: trades.length,
    wins: wins.length,
    losses: losses.length,
    realized,
    grossWin,
    grossLoss,
    avgR,
  };
}
