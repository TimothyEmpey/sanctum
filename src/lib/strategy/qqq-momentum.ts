import { QQQ_ASSET } from "@/lib/assets";
import { evaluateIntradayMomentum, type MomentumContext } from "@/lib/strategy/intraday-momentum";

/** Same published clock as SPY. The strategy id stays QQQ's own. */
export function evaluateQqqMomentum(context: MomentumContext) {
  return evaluateIntradayMomentum(context, {
    symbol: "QQQ",
    strategy: QQQ_ASSET.strategyId,
    setup: QQQ_ASSET.setup,
  });
}
