import { assertTradableSymbol } from "@/lib/broker/firewall";
import { etParts } from "@/lib/market/time";
import { TRADABLE_SYMBOL } from "@/lib/risk/constants";
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
    detail: "Alpaca paper is connected. Orders go to the paper host only. Uriel sizes from cash, not margin buying power.",
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
  assertTradableSymbol(input.symbol);
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new Error("Alpaca paper orders must be a positive whole number of SPY shares.");
  }
  if (!(input.stopPrice > 0) || input.stopPrice >= input.limitPrice) {
    throw new Error("Refusing a paper order without a stop below the limit.");
  }
  if (!(input.targetPrice > input.limitPrice)) {
    throw new Error("Refusing a paper order without a target above the limit.");
  }
  return {
    symbol: TRADABLE_SYMBOL,
    qty: String(input.quantity),
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

export function getPaperOrder(orderId: string) {
  return alpacaFetch<AlpacaOrder>(`/v2/orders/${encodeURIComponent(orderId)}?nested=true`);
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

export function sellPaperShares(quantity: number) {
  assertTradableSymbol(TRADABLE_SYMBOL);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error("Exit quantity must be a positive whole number of shares.");
  }
  return alpacaFetch<AlpacaOrder>("/v2/orders", {
    method: "POST",
    body: JSON.stringify({
      symbol: TRADABLE_SYMBOL,
      qty: String(quantity),
      side: "sell",
      type: "market",
      time_in_force: "day",
    }),
  });
}

export async function syncAlpacaPaper(accountId: string, now: Date) {
  if (!alpacaPaperConfigured()) return false;
  const [remote, positions, local, openTrades] = await Promise.all([
    alpacaFetch<AlpacaAccount>("/v2/account"),
    alpacaFetch<AlpacaPosition[]>("/v2/positions"),
    prisma.account.findUniqueOrThrow({ where: { id: accountId } }),
    prisma.trade.findMany({ where: { accountId, status: "OPEN", origin: "ENGINE", symbol: TRADABLE_SYMBOL } }),
  ]);
  if (remote.trading_blocked || remote.account_blocked || remote.status !== "ACTIVE") {
    throw new Error("Alpaca paper account is not active.");
  }
  const equityCents = dollarsToCents(remote.equity);
  const cashCents = dollarsToCents(remote.cash);
  const engineQty = openTrades.reduce((sum, trade) => sum + trade.quantity, 0);
  const kept = new Set<string>();

  for (const position of positions) {
    const symbol = position.symbol.toUpperCase();
    const qty = Math.abs(Number(position.qty));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const averagePrice = Number(position.avg_entry_price ?? 0);
    const marketPrice = Number(position.current_price ?? averagePrice);
    if (symbol === TRADABLE_SYMBOL) {
      const baseline = Math.max(0, qty - engineQty);
      if (baseline <= 0) continue;
      kept.add(symbol);
      await prisma.holding.upsert({
        where: { accountId_symbol: { accountId, symbol } },
        create: {
          accountId,
          symbol,
          quantity: baseline,
          averagePrice,
          marketPrice,
          origin: "BASELINE",
          tradable: false,
        },
        update: { quantity: baseline, averagePrice, marketPrice, origin: "BASELINE", tradable: false },
      });
      continue;
    }
    kept.add(symbol);
    await prisma.holding.upsert({
      where: { accountId_symbol: { accountId, symbol } },
      create: {
        accountId,
        symbol,
        quantity: qty,
        averagePrice,
        marketPrice,
        origin: "UNTOUCHABLE",
        tradable: false,
      },
      update: { quantity: qty, averagePrice, marketPrice, origin: "UNTOUCHABLE", tradable: false },
    });
  }

  await prisma.holding.deleteMany({
    where: kept.size === 0 ? { accountId } : { accountId, symbol: { notIn: [...kept] } },
  });

  const first = local.mode !== "ALPACA_PAPER";
  const dateKey = etParts(now).dateKey;
  await prisma.account.update({
    where: { id: accountId },
    data: {
      mode: "ALPACA_PAPER",
      demo: false,
      cashCents,
      equityCents,
      ...(first
        ? {
            dayStartEquityCents: equityCents,
            weekStartEquityCents: equityCents,
            peakEquityCents: equityCents,
            dayStartDate: dateKey,
            haltReason: null,
          }
        : {}),
    },
  });
  if (first) {
    await prisma.agentEvent.create({
      data: {
        accountId,
        kind: "BROKER",
        level: "info",
        message: "Alpaca paper connected. The book now follows that account. Uriel trades SPY only and sizes from cash.",
      },
    });
  }
  return true;
}
