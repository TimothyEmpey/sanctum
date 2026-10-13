import { assetBySymbol } from "@/lib/assets";

export class UntouchableSymbolError extends Error {
  constructor(symbol: string) {
    super(`${symbol} is untouchable. Orders are limited to SPY, QQQ, BTC, and ETH.`);
    this.name = "UntouchableSymbolError";
  }
}

export function assertTradableSymbol(symbol: string) {
  if (!assetBySymbol(symbol)) throw new UntouchableSymbolError(symbol);
}

export function assertAgentExit(input: {
  symbol: string;
  quantity: number;
  agentQuantity: number;
  baselineQuantity: number;
}) {
  const asset = assetBySymbol(input.symbol);
  assertTradableSymbol(input.symbol);
  if (asset?.wholeShares !== false) {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) {
      throw new Error("Exit quantity must be a positive whole number of shares.");
    }
  } else if (!(input.quantity > 0)) {
    throw new Error("Exit quantity must be positive.");
  }
  if (input.quantity > input.agentQuantity) {
    throw new Error(
      `Exit of ${input.quantity} ${input.symbol} would touch ${input.baselineQuantity} reserved baseline shares.`,
    );
  }
}
