import { STRATEGY_ID, STRATEGY_NAME } from "@/lib/risk/constants";
import { MOMENTUM_SETUP } from "@/lib/strategy/intraday-momentum";

/** Sizing book. The Alpaca paper account is larger and is not reset. */
export const WORKING_BOOK_CENTS = 100_000;

export type DeskName = "uriel" | "fonzo" | "sanctum";
export type AssetClass = "stocks" | "crypto";
export type AssetMarket = "nyse" | "crypto";

export type Asset = {
  symbol: string;
  yahoo: string;
  desk: "uriel" | "fonzo";
  assetClass: AssetClass;
  market: AssetMarket;
  strategyId: string;
  strategyName: string;
  setup: string;
  wholeShares: boolean;
  quantityStep: number;
  playbook: string;
};

export const SPY_ASSET: Asset = {
  symbol: "SPY",
  yahoo: "SPY",
  desk: "uriel",
  assetClass: "stocks",
  market: "nyse",
  strategyId: STRATEGY_ID,
  strategyName: STRATEGY_NAME,
  setup: MOMENTUM_SETUP,
  wholeShares: true,
  quantityStep: 1,
  playbook:
    "The playbook is the SPY last-half-hour rule from Gao, Han, Li, and Zhou, Journal of Financial Economics (2018). The signal is the return from the previous close to 10:00 ET. If that return is positive, Uriel buys at 3:30 PM ET and sells at the cash close. If it is not, Uriel does not trade. The paper shorts a down signal. This desk does not, so it takes only the long side of that result. On 1993–2013 data the long-and-short version in the paper made about 6.67% a year before costs, Sharpe about 1.08. After the bid-ask spread that was about 4.46% a year. A long-only account is a smaller slice, and the sample ends in 2013. The stop is 2% under the entry so the risk engine can still buy with the cash on hand. The paper does not use a profit target. The model writes a journal line after the fact. It does not choose the order.",
};

export const QQQ_ASSET: Asset = {
  symbol: "QQQ",
  yahoo: "QQQ",
  desk: "uriel",
  assetClass: "stocks",
  market: "nyse",
  strategyId: "qqq-intraday-momentum-2018",
  strategyName: "QQQ last half-hour, long-only",
  setup: MOMENTUM_SETUP,
  wholeShares: true,
  quantityStep: 1,
  playbook:
    "QQQ uses the same last-half-hour clock as SPY. Gao, Han, Li, and Zhou reported that intraday pattern in the most actively traded ETFs, including the Nasdaq ETF. A 2026 replication of the rule on QQQ did not clear a 2 basis point round trip. Uriel still runs the published long-only rule: buy at 3:30 PM ET only when the return from the previous close to 10:00 ET is positive, and sell at the cash close. The stop is 2% under the entry. This is not a claim that QQQ will earn the SPY sample return.",
};

export const BTC_ASSET: Asset = {
  symbol: "BTC/USD",
  yahoo: "BTC-USD",
  desk: "fonzo",
  assetClass: "crypto",
  market: "crypto",
  strategyId: "btc-intraday-momentum-2022",
  strategyName: "BTC last half-hour, long-only",
  setup: "CRYPTO_LAST_HALF",
  wholeShares: false,
  quantityStep: 0.0001,
  playbook:
    "Bitcoin follows the last-half-hour shape in Shen, Urquhart, and Zhu, Financial Review (2022). They found that the first half-hour predicts the last half-hour. Bitcoin has no cash open, so they used volume as the clock. Fonzo uses the UTC day as the session: the 00:00–00:30 UTC return is the signal, the buy is 23:30 UTC, and the sell is 24:00 UTC. A down or flat signal stays flat. Their economic gains were strongest in downturns and came from liquidity provision. This is the long-only UTC version of that clock, not a reproduction of the volume clock, and it is not a promised return. The stop is 2% under the entry.",
};

export const ETH_ASSET: Asset = {
  symbol: "ETH/USD",
  yahoo: "ETH-USD",
  desk: "fonzo",
  assetClass: "crypto",
  market: "crypto",
  strategyId: "eth-intraday-momentum-2022",
  strategyName: "ETH last half-hour, long-only",
  setup: "CRYPTO_LAST_HALF",
  wholeShares: false,
  quantityStep: 0.0001,
  playbook:
    "Ethereum uses the same UTC clock as Bitcoin. Wen, Bouri, Xu, and Zhao, North American Journal of Economics and Finance (2022), found intraday return predictability in Ethereum as well as Bitcoin, Litecoin, and Ripple, from March 2013 through May 2020. A timing strategy in that sample beat buy-and-hold. Fonzo does not invent a separate ETH return. The signal is the 00:00–00:30 UTC return. If it is positive, Fonzo buys at 23:30 UTC and sells at 24:00 UTC. If it is not, Fonzo stays flat. The stop is 2% under the entry.",
};

export const ASSETS: Asset[] = [SPY_ASSET, QQQ_ASSET, BTC_ASSET, ETH_ASSET];
export const STOCK_ASSETS = ASSETS.filter((asset) => asset.assetClass === "stocks");
export const CRYPTO_ASSETS = ASSETS.filter((asset) => asset.assetClass === "crypto");

export const STOCK_SYMBOLS = STOCK_ASSETS.map((asset) => asset.symbol);
export const CRYPTO_SYMBOLS = CRYPTO_ASSETS.map((asset) => asset.symbol);
export const TRADABLE_SYMBOLS = ASSETS.map((asset) => asset.symbol);

export function assetBySymbol(symbol: string) {
  const key = normalizeSymbol(symbol);
  return ASSETS.find((asset) => asset.symbol === key) ?? null;
}

export function normalizeSymbol(symbol: string) {
  const upper = symbol.toUpperCase().replace("-", "/");
  if (upper === "BTCUSD" || upper === "BTC/USD") return "BTC/USD";
  if (upper === "ETHUSD" || upper === "ETH/USD") return "ETH/USD";
  return upper;
}

export function assetLabel(asset: Asset) {
  return asset.symbol.split("/")[0];
}

export function isSessionExitSetup(setup: string) {
  return setup === MOMENTUM_SETUP || setup === "CRYPTO_LAST_HALF";
}

export function resolveView(book?: string | null, asset?: string | null) {
  const assetClass: AssetClass = book === "crypto" ? "crypto" : "stocks";
  const list = ASSETS.filter((item) => item.assetClass === assetClass);
  const wanted = normalizeSymbol(asset ?? "");
  const found = list.find((item) => item.symbol === wanted || assetLabel(item) === wanted);
  return { assetClass, asset: found ?? list[0] };
}

export function viewQuery(asset: Asset) {
  const params = new URLSearchParams({
    book: asset.assetClass,
    asset: asset.symbol,
  });
  return params.toString();
}

const STOCK_RULES = [
  "Every trade has a stop before the entry is recorded.",
  "A stop can move closer. It cannot move farther away.",
  "Size is floored from 2% of the $1,000 working book divided by the stop distance.",
  "No averaging down and no martingale. After a loss the next buy stays at or below that size.",
  "Two losses in a row locks out new entries for that ETF for the session.",
  "One entry a day for each ETF. Two open positions and 4% combined open risk across the shared book.",
  "Daily loss, weekly loss, and peak drawdown each halt at 5% of the working book.",
  "Uriel trades SPY and QQQ. Fonzo trades BTC and ETH. Anything else is untouchable.",
  "The position is sold at the cash close. The stop is a disaster exit, not a profit target.",
  "The working book is under $25,000, so stock day trades stop at 3 in 5 business days.",
];

const CRYPTO_RULES = [
  "Every trade has a stop before the entry is recorded.",
  "A stop can move closer. It cannot move farther away.",
  "Size is floored from 2% of the $1,000 working book divided by the stop distance.",
  "No averaging down and no martingale. After a loss the next buy stays at or below that size.",
  "Two losses in a row locks out new entries for that coin for the UTC day.",
  "One entry a day for each coin. Two open positions and 4% combined open risk across the shared book.",
  "Daily loss, weekly loss, and peak drawdown each halt at 5% of the working book.",
  "Fonzo trades BTC and ETH. Uriel trades SPY and QQQ. Anything else is untouchable.",
  "The position is sold at 24:00 UTC. The stop is a disaster exit, not a profit target.",
  "Crypto orders are not stock day trades, so they do not add to the pattern day trader count.",
];

export function rulesFor(asset: Asset) {
  return asset.assetClass === "crypto" ? CRYPTO_RULES : STOCK_RULES;
}
