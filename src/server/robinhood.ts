import { MIN_FRACTIONAL_NOTIONAL_CENTS } from "@/lib/assets";
import { assertTradableSymbol } from "@/lib/broker/firewall";
import { notionalCents } from "@/lib/risk/sizing";

const MCP_URL = process.env.ROBINHOOD_MCP_URL ?? "https://agent.robinhood.com/mcp/trading";

export type RobinhoodStatus = {
  connected: boolean;
  liveArmed: boolean;
  detail: string;
};

type JsonRpc = {
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
    tools?: unknown;
  };
  error?: { message?: string };
};

export function robinhoodStatus(): RobinhoodStatus {
  const connected = Boolean(process.env.ROBINHOOD_MCP_TOKEN);
  const liveArmed = connected && process.env.LIVE_TRADING === "true" && process.env.ROBINHOOD_ORDER_CONFIRMED === "true";
  if (!connected) {
    return {
      connected: false,
      liveArmed: false,
      detail: "Paper ledger. Robinhood reads the agent account only after you connect https://agent.robinhood.com/mcp/trading and set ROBINHOOD_MCP_TOKEN.",
    };
  }
  if (!liveArmed) {
    return {
      connected: true,
      liveArmed: false,
      detail: "Token is set. Live orders stay off until the order schema is confirmed and LIVE_TRADING=true.",
    };
  }
  return { connected: true, liveArmed: true, detail: "Live SPY orders are armed. The risk engine still sits in front of every order." };
}

async function mcpCall(method: string, params: Record<string, unknown>, sessionId?: string) {
  const token = process.env.ROBINHOOD_MCP_TOKEN;
  if (!token) throw new Error("Robinhood MCP token is not set.");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const nextSession = response.headers.get("mcp-session-id") ?? sessionId;
  const text = await response.text();
  const payload = text.includes("data:")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .at(-1)
    : text;
  const parsed = payload ? (JSON.parse(payload) as JsonRpc) : {};
  if (!response.ok || parsed.error) {
    throw new Error(parsed.error?.message ?? `Robinhood MCP returned ${response.status}`);
  }
  return { parsed, sessionId: nextSession ?? undefined };
}

export async function robinhoodTool(name: string, args: Record<string, unknown>) {
  const initialized = await mcpCall("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "uriel", version: "0.1.0" },
  });
  return mcpCall(
    "tools/call",
    { name, arguments: args },
    initialized.sessionId,
  );
}

/**
 * Live orders fail closed. A token is not permission to guess the order payload.
 * The symbol firewall still runs first, so a confirmed payload cannot name another asset.
 */
export async function placeRobinhoodEquityOrder(input: {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  limitPrice: number;
  stopPrice: number;
}) {
  assertTradableSymbol(input.symbol);
  if (process.env.LIVE_TRADING !== "true" || process.env.ROBINHOOD_ORDER_CONFIRMED !== "true") {
    throw new Error("Live Robinhood orders are not armed.");
  }
  if (!(input.stopPrice > 0) || !(input.quantity > 0)) {
    throw new Error("Refusing a live order without a stop and a share quantity.");
  }
  if (notionalCents(input.quantity, input.limitPrice) < MIN_FRACTIONAL_NOTIONAL_CENTS) {
    throw new Error("A fractional buy starts at $1.");
  }
  return robinhoodTool("review_equity_order", {
    symbol: input.symbol,
    side: input.side.toLowerCase(),
    quantity: input.quantity,
    type: "limit",
    limit_price: input.limitPrice,
    stop_price: input.stopPrice,
  });
}
