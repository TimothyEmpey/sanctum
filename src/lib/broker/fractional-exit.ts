import { roundPrice } from "@/lib/market/time";

export type ExitBar = { ts: number; high: number; low: number };

/** Stop wins on the same bar. A bar from before the fill is ignored. */
export function fractionalExitChoice(input: {
  openedAt: number;
  stop: number;
  target: number;
  bars: ExitBar[];
}): "stop" | "target" | "hold" {
  for (const bar of input.bars) {
    if (bar.ts < input.openedAt) continue;
    if (bar.low <= input.stop) return "stop";
    if (bar.high >= input.target) return "target";
  }
  return "hold";
}

type ProposalPrices = {
  symbol?: string;
  entryPrice?: number;
  stopPrice?: number;
  targetPrice?: number;
};

/** The playbook target stored on the risk decision, when it still sits above the fill. */
export function matchingTarget(
  proposal: ProposalPrices | null,
  order: { symbol: string; limitPrice: number; stopPrice: number },
  fill: number,
): number | null {
  if (!proposal || proposal.symbol !== order.symbol) return null;
  if (proposal.entryPrice == null || proposal.stopPrice == null || proposal.targetPrice == null) return null;
  if (Math.abs(proposal.entryPrice - order.limitPrice) >= 0.02) return null;
  if (Math.abs(proposal.stopPrice - order.stopPrice) >= 0.02) return null;
  if (!(proposal.targetPrice > fill)) return null;
  return roundPrice(proposal.targetPrice);
}

/** One times the risk above the fill, when the playbook target was not kept. */
export function fallbackTarget(fill: number, stop: number) {
  const oneR = roundPrice(fill + Math.abs(fill - stop));
  return oneR > fill ? oneR : roundPrice(fill + 0.01);
}
