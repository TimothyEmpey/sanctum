import { CRYPTO_SETUP } from "@/lib/strategy/crypto-discount";
import { MOMENTUM_SETUP } from "@/lib/strategy/intraday-momentum";
import { NQ_SETUP, NQ_STRATEGY_ID } from "@/lib/strategy/nq-sweep";
import { SPY_SETUP, SPY_STRATEGY_ID, SPY_STRATEGY_NAME } from "@/lib/strategy/spy-structure";

/** Sizing book. The Alpaca paper account is larger and is not reset. */
export const WORKING_BOOK_CENTS = 100_000;

/** Robinhood fractional shares: millionths of a share, and a buy of at least $1. */
export const FRACTIONAL_SHARE_STEP = 0.000001;
export const MIN_FRACTIONAL_NOTIONAL_CENTS = 100;

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
  strategyId: SPY_STRATEGY_ID,
  strategyName: SPY_STRATEGY_NAME,
  setup: SPY_SETUP,
  wholeShares: false,
  quantityStep: FRACTIONAL_SHARE_STEP,
  playbook:
    "SPY follows the chart. An uptrend is higher highs and higher lows. Uriel buys after price trades under a 15-minute swing low and a later 15-minute candle closes above the high that was in place. If that turn is missed, a 15-minute uptrend can still be bought after a 5-minute close under its swing low and a 5-minute close back above its swing high, as long as that dip does not break the 15-minute low. The stop is the sweep or retrace low. The target is the next high above the entry, or one times the risk when no high is drawn. Shorts stay off. Each fresh long can be taken once the prior position is closed, from the open until the cash flatten. The position is out at the target, the stop, or the cash close. The buy is a fraction of a share, at least $1, sent as a simple day order so the 25% share can fund it. The stop rests at the broker, and Uriel sells the target. The model does not choose the order.",
};

export const NQ_ASSET: Asset = {
  symbol: "NQ",
  yahoo: "NQ=F",
  desk: "uriel",
  assetClass: "stocks",
  market: "nyse",
  strategyId: NQ_STRATEGY_ID,
  strategyName: "NQ liquidity sweep, long-only",
  setup: NQ_SETUP,
  wholeShares: false,
  quantityStep: FRACTIONAL_SHARE_STEP,
  playbook:
    "NQ is the Nasdaq-100 futures market. The long setup is a sweep of the prior day's low, a five-minute break of structure up, then a one-minute retrace and a one-minute break back up. The S&P futures have to break structure the same way by 10:20 ET or there is no trade. The buy is only that long continuation, from 9:30 to 10:30 ET. Shorts stay off. The stop is the retrace low and the target is the next high. This is not a claim on anyone's reported win rate. One entry a day. The order is a fraction of the quoted price, at least $1, so the 25% share can fund it. The position is out at the target, the stop, or the cash close.",
};

export const BTC_ASSET: Asset = {
  symbol: "BTC/USD",
  yahoo: "BTC-USD",
  desk: "fonzo",
  assetClass: "crypto",
  market: "crypto",
  strategyId: "btc-discount-range",
  strategyName: "BTC discount range, long-only",
  setup: CRYPTO_SETUP,
  wholeShares: false,
  quantityStep: 0.0001,
  playbook:
    "Bitcoin is bought only in the discount of a broken range. A range is a swing low and a swing high. Fonzo reads the eight-hour chart. He waits for a close above that swing high, then for price to trade back inside the range and into the bottom quarter. The bottom quarter runs from the swing low to one quarter of the way up the range. The stop is the swing low. The target is the high of the range. If the eight-hour chart has no swing, Fonzo reads the four-hour chart, then the one-hour chart. The short setup is off. One entry a UTC day. The buy is a fraction of a coin, sized from 2% of the book and cut to this asset's 25% share. After price moves one times the risk, the stop moves to the entry. The position is out at the target or the stop.",
};

export const ETH_ASSET: Asset = {
  symbol: "ETH/USD",
  yahoo: "ETH-USD",
  desk: "fonzo",
  assetClass: "crypto",
  market: "crypto",
  strategyId: "eth-discount-range",
  strategyName: "ETH discount range, long-only",
  setup: CRYPTO_SETUP,
  wholeShares: false,
  quantityStep: 0.0001,
  playbook:
    "Ethereum uses the same discount range as Bitcoin. Fonzo does not invent a separate ETH entry. A close above the swing high, a return back inside the range, and a trade into the bottom quarter is the buy. The stop is the swing low and the target is the range high. The eight-hour chart is read first, then the four-hour, then the one-hour, and only when the higher chart has no swing. The short setup is off. One entry a UTC day. The buy is a fraction of a coin, sized from 2% of the book and cut to this asset's 25% share. The position is out at the target or the stop.",
};

export const ASSETS: Asset[] = [SPY_ASSET, NQ_ASSET, BTC_ASSET, ETH_ASSET];

/** Even share of account equity. Four assets, so each one is designated 25%. */
export function assetShareCents(equityCents: number) {
  if (!(equityCents > 0) || ASSETS.length === 0) return 0;
  return Math.floor(equityCents / ASSETS.length);
}
export const STOCK_ASSETS = ASSETS.filter((asset) => asset.assetClass === "stocks");
export const CRYPTO_ASSETS = ASSETS.filter((asset) => asset.assetClass === "crypto");

export const STOCK_SYMBOLS = STOCK_ASSETS.map((asset) => asset.symbol);
export const CRYPTO_SYMBOLS = CRYPTO_ASSETS.map((asset) => asset.symbol);
export const TRADABLE_SYMBOLS = ASSETS.map((asset) => asset.symbol);

/** Uriel's symbols share a desk. Fonzo's symbols share the other. A position on one does not count on the other. */
export function sameDesk(symbol: string, other: string) {
  const left = assetBySymbol(symbol);
  const right = assetBySymbol(other);
  return Boolean(left && right && left.desk === right.desk);
}

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
  return setup === MOMENTUM_SETUP;
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
  "Size is floored from 2% of the $1,000 working book divided by the stop distance. Uriel buys a fraction of a share, at least $1, the way Robinhood does.",
  "SPY, NQ, BTC, and ETH are each designated 25% of account equity. An order cannot spend another asset share.",
  "No averaging down and no martingale. NQ stays at or below the previous losing size. Each SPY long is sized from its own stop.",
  "Two losses in a row locks NQ for the session. SPY does not use that lockout.",
  "NQ gets one entry a day. SPY can take each new long after the prior position is closed. Uriel counts its own 2 open positions and 4% open risk. Fonzo's positions are not included.",
  "Daily loss, weekly loss, and peak drawdown each halt at 5% of the working book.",
  "Uriel trades SPY and NQ. Fonzo trades BTC and ETH. Anything else is untouchable.",
  "SPY and NQ are out at the target, the stop, or the cash close.",
];

const CRYPTO_RULES = [
  "Every trade has a stop before the entry is recorded.",
  "A stop can move closer. It cannot move farther away.",
  "Size is floored from 2% of the $1,000 working book divided by the stop distance. The buy is a fraction of a coin. A whole coin is not required.",
  "SPY, NQ, BTC, and ETH are each designated 25% of account equity. An order cannot spend another asset share.",
  "No averaging down and no martingale. After a loss the next buy stays at or below that size.",
  "Two losses in a row locks out new entries for that coin for the UTC day.",
  "One entry a day for each coin. Fonzo counts its own 2 open positions and 4% open risk. Uriel's positions are not included.",
  "Daily loss, weekly loss, and peak drawdown each halt at 5% of the working book.",
  "Fonzo trades BTC and ETH. Uriel trades SPY and NQ. Anything else is untouchable.",
  "The position is out at the target or the stop. There is no clock exit.",
];

export function rulesFor(asset: Asset) {
  return asset.assetClass === "crypto" ? CRYPTO_RULES : STOCK_RULES;
}
