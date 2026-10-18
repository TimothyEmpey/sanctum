import { assetBySymbol, normalizeSymbol } from "@/lib/assets";
import { assertTradableSymbol, UntouchableSymbolError } from "@/lib/broker/firewall";
import { prisma } from "@/server/db";

const PAPER_HOST = "paper-api.alpaca.markets";

export type AlpacaStatus = {
  configured: boolean;
  detail: string;
};

type AlpacaAccount = {
  status?: string;
  equity?: string;
  cash?: string;
  trading_blocked?: boolean;
  account_blocked?: boolean;
};

type AlpacaPosition = {
  symbol: string;
  qty: string;
  side?: string;
  avg_entry_price?: string;
  current_price?: string;
};

export type AlpacaOrder = {
  id: string;
  status: string;
  filled_avg_price?: string | null;
  filled_qty?: string | null;
  legs?: AlpacaOrder[];
  type?: string;
  side?: string;
  stop_price?: string | null;
  limit_price?: string | null;
  message?: string;
};

export function assertPaperBaseUrl(raw: string) {
  const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  if (url.protocol !== "https:" || url.hostname !== PAPER_HOST) {
    throw new Error("Alpaca orders are locked to the paper host.");
  }
  return `https://${PAPER_HOST}`;
}

export function alpacaPaperConfigured() {
  if (!process.env.APCA_API_KEY_ID || !process.env.APCA_API_SECRET_KEY) return false;
  try {
    assertPaperBaseUrl(process.env.APCA_API_BASE_URL ?? `https://${PAPER_HOST}`);
    return true;
  } catch {
    return false;
  }
}

export function alpacaStatus(): AlpacaStatus {
  if (!alpacaPaperConfigured()) {
    return { configured: false, detail: "Alpaca paper keys are not set." };
  }
  return {
    configured: true,
    detail: "Alpaca paper is connected. Orders use the $1,000 working book, not margin, and the Alpaca account is not reset.",
  };
}

export function paperBracketOrder(input: {
  symbol: string;
  quantity: number;
  limitPrice: number;
  stopPrice: number;
  targetPrice: number;
  clientOrderId: string;
}) {
  const asset = assetBySymbol(input.symbol);
  if (!asset || asset.assetClass !== "stocks") throw new UntouchableSymbolError(input.symbol);
  if (asset.symbol === "NQ") throw new Error("Alpaca paper has no Nasdaq futures contract.");
  if (asset.wholeShares && (!Number.isInteger(input.quantity) || input.quantity < 1)) {
    throw new Error("Alpaca paper stock orders must be a positive whole number of shares.");
  }
  if (!asset.wholeShares && !(input.quantity > 0)) {
    throw new Error("Alpaca paper stock orders need a positive quantity.");
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new Error("A fractional order cannot be a bracket.");
  }
  if (!(input.stopPrice > 0) || input.stopPrice >= input.limitPrice) {
    throw new Error("Refusing a paper order without a stop below the limit.");
  }
  if (!(input.targetPrice > input.limitPrice)) {
    throw new Error("Refusing a paper order without a target above the limit.");
  }
  return {
    symbol: input.symbol,
    qty: formatOrderQty(input.quantity, true),
    side: "buy",
    type: "limit",
    time_in_force: "day",
    limit_price: input.limitPrice.toFixed(2),
    order_class: "bracket",
    client_order_id: input.clientOrderId,
    take_profit: { limit_price: input.targetPrice.toFixed(2) },
    stop_loss: { stop_price: input.stopPrice.toFixed(2) },
  };
}

/** Fractional SPY buy. Alpaca accepts this only when no bracket is attached. */
export function paperStockLimitBuy(input: {
  symbol: string;
  quantity: number;
  limitPrice: number;
  stopPrice: number;
  targetPrice: number;
  clientOrderId: string;
}) {
  const asset = assetBySymbol(input.symbol);
  if (!asset || asset.assetClass !== "stocks") throw new UntouchableSymbolError(input.symbol);
  if (asset.symbol === "NQ") throw new Error("Alpaca paper has no Nasdaq futures contract.");
  if (!(input.quantity > 0)) throw new Error("Alpaca paper stock orders need a positive quantity.");
  if (!(input.stopPrice > 0) || input.stopPrice >= input.limitPrice) {
    throw new Error("Refusing a paper order without a stop below the limit.");
  }
  if (!(input.targetPrice > input.limitPrice)) {
    throw new Error("Refusing a paper order without a target above the limit.");
  }
  return {
    symbol: input.symbol,
    qty: formatOrderQty(input.quantity, asset.wholeShares),
    side: "buy",
    type: "limit",
    time_in_force: "day",
    limit_price: input.limitPrice.toFixed(2),
    client_order_id: input.clientOrderId,
  };
}

/** Protective stop for a fractional share. It is a separate day order, not a bracket leg. */
export function paperStockStop(input: { symbol: string; quantity: number; stopPrice: number; clientOrderId: string }) {
  const asset = assetBySymbol(input.symbol);
  if (!asset || asset.assetClass !== "stocks") throw new UntouchableSymbolError(input.symbol);
  if (asset.symbol === "NQ") throw new Error("Alpaca paper has no Nasdaq futures contract.");
  if (!(input.quantity > 0)) throw new Error("Alpaca paper stock orders need a positive quantity.");
  if (!(input.stopPrice > 0)) throw new Error("Refusing a paper stop without a price.");
  return {
    symbol: input.symbol,
    qty: formatOrderQty(input.quantity, asset.wholeShares),
    side: "sell",
    type: "stop",
    time_in_force: "day",
    stop_price: input.stopPrice.toFixed(2),
    client_order_id: input.clientOrderId,
  };
}

function dollarsToCents(value: string | undefined) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new Error("Alpaca returned a non-numeric balance.");
  return Math.round(amount * 100);
}

/** Read equity and cash. Does not place or change an order. */
export async function getPaperBalances() {
  const remote = await alpacaFetch<AlpacaAccount>("/v2/account");
  return {
    equityCents: dollarsToCents(remote.equity),
    cashCents: dollarsToCents(remote.cash),
  };
}

async function alpacaFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const key = process.env.APCA_API_KEY_ID;
  const secret = process.env.APCA_API_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca paper keys are not set.");
  const base = assertPaperBaseUrl(process.env.APCA_API_BASE_URL ?? `https://${PAPER_HOST}`);
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as T & { message?: string }) : ({} as T & { message?: string });
  if (!response.ok) {
    throw new Error(payload.message || `Alpaca paper returned ${response.status}.`);
  }
  return payload;
}

export function placePaperBracket(input: Parameters<typeof paperBracketOrder>[0]) {
  return alpacaFetch<AlpacaOrder>("/v2/orders", {
    method: "POST",
    body: JSON.stringify(paperBracketOrder(input)),
  });
}

export function placePaperStockLimit(input: Parameters<typeof paperStockLimitBuy>[0]) {
  return alpacaFetch<AlpacaOrder>("/v2/orders", {
    method: "POST",
    body: JSON.stringify(paperStockLimitBuy(input)),
  });
}

export function placePaperStockStop(input: Parameters<typeof paperStockStop>[0]) {
  return alpacaFetch<AlpacaOrder>("/v2/orders", {
    method: "POST",
    body: JSON.stringify(paperStockStop(input)),
  });
}

export function getPaperOrder(orderId: string) {
  return alpacaFetch<AlpacaOrder>(`/v2/orders/${encodeURIComponent(orderId)}?nested=true`);
}

export function getPaperOrderByClientId(clientOrderId: string) {
  return alpacaFetch<AlpacaOrder>(
    `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
  );
}

export function cancelPaperOrder(orderId: string) {
  return alpacaFetch<unknown>(`/v2/orders/${encodeURIComponent(orderId)}`, { method: "DELETE" });
}

export function replacePaperStop(orderId: string, stopPrice: number) {
  return alpacaFetch<AlpacaOrder>(`/v2/orders/${encodeURIComponent(orderId)}`, {
    method: "PATCH",
    body: JSON.stringify({ stop_price: stopPrice.toFixed(2) }),
  });
}

export function replacePaperLimit(orderId: string, limitPrice: number) {
  return alpacaFetch<AlpacaOrder>(`/v2/orders/${encodeURIComponent(orderId)}`, {
    method: "PATCH",
    body: JSON.stringify({ limit_price: limitPrice.toFixed(2) }),
  });
}

export function formatOrderQty(quantity: number, whole: boolean) {
  if (whole) return String(Math.round(quantity));
  return quantity.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

export function paperCryptoLimitBuy(input: { symbol: string; quantity: number; limitPrice: number; clientOrderId: string }) {
  const asset = assetBySymbol(input.symbol);
  if (!asset || asset.market !== "crypto") throw new UntouchableSymbolError(input.symbol);
  if (!(input.quantity > 0) || !(input.limitPrice > 0)) throw new Error("Crypto orders need a price and a quantity.");
  return {
    symbol: asset.symbol,
    qty: formatOrderQty(input.quantity, false),
    side: "buy",
    type: "limit",
    time_in_force: "gtc",
    limit_price: input.limitPrice.toFixed(2),
    client_order_id: input.clientOrderId,
  };
}

export function paperCryptoStop(input: { symbol: string; quantity: number; stopPrice: number; clientOrderId: string }) {
  const asset = assetBySymbol(input.symbol);
  if (!asset || asset.market !== "crypto") throw new UntouchableSymbolError(input.symbol);
  const limit = Math.round(input.stopPrice * 0.995 * 100) / 100;
  if (!(limit > 0) || !(limit < input.stopPrice)) throw new Error("Refusing a crypto stop that is not below the trigger.");
  return {
    symbol: asset.symbol,
    qty: formatOrderQty(input.quantity, false),
    side: "sell",
    type: "stop_limit",
    time_in_force: "gtc",
    stop_price: input.stopPrice.toFixed(2),
    limit_price: limit.toFixed(2),
    client_order_id: input.clientOrderId,
  };
}

export function placePaperCryptoLimit(input: Parameters<typeof paperCryptoLimitBuy>[0]) {
  return alpacaFetch<AlpacaOrder>("/v2/orders", { method: "POST", body: JSON.stringify(paperCryptoLimitBuy(input)) });
}

export function placePaperCryptoStop(input: Parameters<typeof paperCryptoStop>[0]) {
  return alpacaFetch<AlpacaOrder>("/v2/orders", { method: "POST", body: JSON.stringify(paperCryptoStop(input)) });
}

export function sellPaperShares(symbol: string, quantity: number, clientOrderId?: string) {
  const asset = assetBySymbol(symbol);
  assertTradableSymbol(symbol);
  if (!asset) throw new UntouchableSymbolError(symbol);
  if (asset.symbol === "NQ") throw new Error("Alpaca paper has no Nasdaq futures contract.");
  if (asset.wholeShares && (!Number.isInteger(quantity) || quantity < 1)) {
    throw new Error("Exit quantity must be a positive whole number of shares.");
  }
  if (!asset.wholeShares && !(quantity > 0)) throw new Error("Exit quantity must be positive.");
  return alpacaFetch<AlpacaOrder>("/v2/orders", {
    method: "POST",
    body: JSON.stringify({
      symbol: asset.symbol,
      qty: formatOrderQty(quantity, asset.wholeShares),
      side: "sell",
      type: "market",
      time_in_force: asset.market === "crypto" ? "ioc" : "day",
      ...(clientOrderId ? { client_order_id: clientOrderId } : {}),
    }),
  });
}

/** Reuse the broker order for this client id so a retry cannot sell the share twice. */
export async function sellPaperSharesOnce(symbol: string, quantity: number, clientOrderId: string) {
  try {
    const existing = await getPaperOrderByClientId(clientOrderId);
    if (existing.id) return existing;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/404|not found/i.test(message)) throw error;
  }
  return sellPaperShares(symbol, quantity, clientOrderId);
}

export async function syncAlpacaPaper(accountId: string, now: Date) {
  if (!alpacaPaperConfigured()) return false;
  const [remote, positions, local, openTrades] = await Promise.all([
    alpacaFetch<AlpacaAccount>("/v2/account"),
    alpacaFetch<AlpacaPosition[]>("/v2/positions"),
    prisma.account.findUniqueOrThrow({ where: { id: accountId } }),
    prisma.trade.findMany({ where: { accountId, status: "OPEN", origin: "ENGINE" } }),
  ]);
  if (remote.trading_blocked || remote.account_blocked || remote.status !== "ACTIVE") {
    throw new Error("Alpaca paper account is not active.");
  }
  const brokerEquityCents = dollarsToCents(remote.equity);
  const brokerCashCents = dollarsToCents(remote.cash);
  const engineQty = new Map<string, number>();
  for (const trade of openTrades) {
    const symbol = normalizeSymbol(trade.symbol);
    engineQty.set(symbol, (engineQty.get(symbol) ?? 0) + trade.quantity);
  }
  const kept = new Set<string>();

  for (const position of positions) {
    const symbol = normalizeSymbol(position.symbol);
    const qty = Math.abs(Number(position.qty));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const averagePrice = Number(position.avg_entry_price ?? 0);
    const marketPrice = Number(position.current_price ?? averagePrice);
    const asset = assetBySymbol(symbol);
    const quantity = asset ? Math.max(0, qty - (engineQty.get(symbol) ?? 0)) : qty;
    if (asset && quantity <= 0) continue;
    kept.add(symbol);
    const origin = asset ? "BASELINE" : "UNTOUCHABLE";
    await prisma.holding.upsert({
      where: { accountId_symbol: { accountId, symbol } },
      create: {
        accountId,
        symbol,
        quantity,
        averagePrice,
        marketPrice,
        origin,
        tradable: false,
      },
      update: { quantity, averagePrice, marketPrice, origin, tradable: false },
    });
  }

  await prisma.holding.deleteMany({
    where: kept.size === 0 ? { accountId } : { accountId, symbol: { notIn: [...kept] } },
  });

  const first = local.mode !== "ALPACA_PAPER";
  await prisma.account.update({
    where: { id: accountId },
    data: {
      mode: "ALPACA_PAPER",
      demo: false,
      brokerEquityCents,
      brokerCashCents,
      ...(first ? { haltReason: null } : {}),
    },
  });
  if (first) {
    await prisma.agentEvent.create({
      data: {
        accountId,
        kind: "BROKER",
        level: "info",
        message: "Alpaca paper connected. The $1,000 working book stays in place. That account is the broker and is not reset.",
        payload: { connectedAt: now.toISOString() },
      },
    });
  }
  return true;
}
