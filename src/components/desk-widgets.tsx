import type { Desk } from "@/server/desk";
import { formatPx, formatUsd } from "@/lib/market/time";
import { Badge } from "@/components/ui/badge";
import { MOMENTUM_SETUP } from "@/lib/strategy/intraday-momentum";
import { Card, CardTitle } from "@/components/ui/card";

export function DemoBanner() {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[color-mix(in_oklab,var(--primary)_10%,transparent)] px-4 py-3 text-sm">
      Paper demo book. These holdings and sample prints are not your brokerage account. Uriel cannot sell anything except SPY shares it buys, and live orders stay off.
    </div>
  );
}

export function BookBanner({ mode, demo }: { mode: string; demo: boolean }) {
  if (mode === "ALPACA_PAPER") {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[color-mix(in_oklab,var(--primary)_10%,transparent)] px-4 py-3 text-sm">
        Alpaca paper account. Equity, cash, and positions come from that account. Uriel sells only SPY shares it buys, and it sizes from cash rather than margin.
      </div>
    );
  }
  if (!demo) return null;
  return <DemoBanner />;
}

export function Metric({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "bad" }) {
  return (
    <Card>
      <CardTitle>{label}</CardTitle>
      <p className={`tabular mt-2 text-2xl font-semibold tracking-tight ${tone === "good" ? "text-[var(--positive)]" : tone === "bad" ? "text-[var(--negative)]" : ""}`}>
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p> : null}
    </Card>
  );
}

export function moneyTone(cents: number): "good" | "bad" | undefined {
  if (cents > 0) return "good";
  if (cents < 0) return "bad";
  return undefined;
}

function OriginBadge({ origin }: { origin: string }) {
  const label = origin === "UNTOUCHABLE" ? "Locked" : origin === "BASELINE" ? "Reserved" : origin === "DEMO" ? "Sample" : "Uriel";
  return <Badge>{label}</Badge>;
}

export function PositionBook({ desk, includeUntouchable = true }: { desk: Desk; includeUntouchable?: boolean }) {
  const baseline = desk.holdings.filter((holding) => holding.origin === "BASELINE");
  const locked = desk.holdings.filter((holding) => holding.origin === "UNTOUCHABLE");
  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>Open positions</CardTitle>
        <div className="mt-3 space-y-2">
          {desk.openTrades.length === 0 && baseline.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No open SPY day trade.</p>
          ) : null}
          {desk.openTrades.map((trade) => (
            <PositionRow
              key={trade.id}
              symbol={trade.symbol}
              detail={
                trade.setup === MOMENTUM_SETUP
                  ? `${trade.side} ${trade.quantity} · entry ${formatPx(trade.entryPrice)} · stop ${formatPx(trade.stopPrice)} · exit at the cash close`
                  : `${trade.side} ${trade.quantity} · entry ${formatPx(trade.entryPrice)} · stop ${formatPx(trade.stopPrice)} · target ${formatPx(trade.targetPrice)}`
              }
              value={formatUsd(trade.unrealizedCents, true)}
              origin={trade.origin}
            />
          ))}
          {baseline.map((holding) => (
            <PositionRow
              key={holding.symbol}
              symbol={holding.symbol}
              detail={`${formatQty(holding.quantity)} shares reserved · avg ${formatPx(holding.averagePrice)} · last ${formatPx(holding.marketPrice)}`}
              value={formatUsd(holding.marketValueCents)}
              origin="BASELINE"
            />
          ))}
        </div>
      </Card>
      {includeUntouchable ? (
        <Card>
          <CardTitle>Untouchable holdings</CardTitle>
          <p className="mt-1 text-xs text-[var(--muted)]">Anything other than SPY and USD is display-only. Uriel cannot sell these.</p>
          <div className="mt-3 space-y-2">
            {locked.length === 0 ? <p className="text-sm text-[var(--muted)]">No outside holdings in this book.</p> : null}
            {locked.map((holding) => (
              <PositionRow
                key={holding.symbol}
                symbol={holding.symbol}
                detail={`${formatQty(holding.quantity)} · avg ${formatPx(holding.averagePrice)} · last ${formatPx(holding.marketPrice)} · open P&L ${formatUsd(holding.unrealizedCents, true)}`}
                value={formatUsd(holding.marketValueCents)}
                origin="UNTOUCHABLE"
              />
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function formatQty(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function PositionRow({ symbol, detail, value, origin }: { symbol: string; detail: string; value: string; origin: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--border)] px-3 py-3">
      <div>
        <div className="flex items-center gap-2">
          <span className="font-medium">{symbol}</span>
          <OriginBadge origin={origin} />
        </div>
        <p className="mt-1 text-xs text-[var(--muted)]">{detail}</p>
      </div>
      <p className="tabular text-sm font-medium">{value}</p>
    </div>
  );
}

export function FillTape({ desk }: { desk: Desk }) {
  const fills = desk.orders.filter((order) => order.status === "FILLED");
  return (
    <Card>
      <CardTitle>Buys and sells</CardTitle>
      <div className="mt-3 divide-y divide-[var(--border)]">
        {fills.length === 0 ? <p className="text-sm text-[var(--muted)]">No fills yet.</p> : null}
        {fills.map((order) => (
          <div key={order.id} className="flex items-center justify-between gap-3 py-3 text-sm">
            <div>
              <div className="flex items-center gap-2">
                <Badge>{order.side}</Badge>
                {order.sample ? <Badge>Sample</Badge> : null}
                <span className="font-medium">{order.symbol}</span>
                <span className="text-[var(--muted)]">{order.purpose}</span>
              </div>
              <p className="mt-1 text-xs text-[var(--muted)]">
                {order.quantity} @ {order.fillPrice == null ? "—" : formatPx(order.fillPrice)} · {new Date(order.filledAt ?? order.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </p>
            </div>
            <span className="text-xs uppercase tracking-wide text-[var(--muted)]">{order.status}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
