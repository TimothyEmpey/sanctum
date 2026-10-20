import { PriceChart } from "@/components/charts";
import { BookBanner, Metric, moneyTone, PositionBook } from "@/components/desk-widgets";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { formatPx, formatUsd } from "@/lib/market/time";
import { heartbeatFresh } from "@/lib/strategy/trigger-caveat";
import { getDesk } from "@/server/desk";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ book?: string; asset?: string }>;
}) {
  const desk = await getDesk(await searchParams);
  if (!desk) return <p>Seed the paper account before opening the desk.</p>;
  const quiet = desk.assetClass === "crypto" ? false : desk.clock.phase === "closed" || desk.clock.phase === "idle";
  const workerFresh = heartbeatFresh(desk.heartbeat?.at, quiet);

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs uppercase tracking-[0.22em] text-[var(--muted)]">{desk.assetLabel} desk</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">{desk.clock.label} · {desk.strategy}</p>
      </div>
      <BookBanner mode={desk.mode} demo={desk.demo} brokerEquityCents={desk.brokerEquityCents} />
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Account equity" value={formatUsd(desk.equityCents)} hint={`Peak ${formatUsd(desk.peakEquityCents)}`} />
        <Metric label="Today's P&L" value={formatUsd(desk.dayPnlCents, true)} tone={moneyTone(desk.dayPnlCents)} />
        <Metric label="Daily loss remaining" value={formatUsd(desk.dailyLossRemainingCents)} hint="5% of starting-day equity" />
        <Metric label="Open risk" value={formatUsd(desk.openRiskCents)} hint={`Cap ${formatUsd(desk.openRiskLimitCents)}`} />
        <Metric
          label="Buying power"
          value={formatUsd(desk.buyingPowerCents)}
          hint={`${desk.assetLabel} is designated ${formatUsd(desk.shareCents)}, 25% of account equity. Cash only. Margin is not used.`}
        />
        <Metric
          label="Open positions"
          value={String(desk.accountOpenPositions)}
          hint={
            desk.symbol === "SPY"
              ? `${desk.tradesToday} SPY entries today. Another long can be taken after this position is closed. Fonzo's positions are not counted.`
              : `${desk.tradesToday} of ${desk.limits.maxTradesPerDay} ${desk.symbol} entries today. The other desk's positions are not counted.`
          }
        />
        <Metric label="Active orders" value={String(desk.orders.filter((order) => order.status === "WORKING").length)} />
        <Metric label="Week P&L" value={formatUsd(desk.weekPnlCents, true)} tone={moneyTone(desk.weekPnlCents)} />
      </section>
      <section className="grid gap-4 lg:grid-cols-5">
        <Card className="min-w-0 lg:col-span-3">
          <div className="mb-3 flex items-baseline justify-between">
            <CardTitle>{desk.assetLabel}</CardTitle>
            <p className="tabular text-lg font-semibold">{desk.mark == null ? "—" : formatPx(desk.mark)}</p>
          </div>
          <PriceChart key={desk.symbol} symbol={desk.assetLabel} daily={desk.bars.daily} minute={desk.bars.minute} />
        </Card>
        <Card className="space-y-3 lg:col-span-2">
          <CardTitle>Status</CardTitle>
          <StatusRow label={desk.workerName} value={workerFresh ? (desk.paused ? "Paused" : "Running") : "Worker offline"} />
          <StatusRow label="Risk engine" value={desk.haltReason ?? "Clear"} />
          <StatusRow label="Broker" value={desk.mode === "ALPACA_PAPER" ? "Alpaca paper" : desk.mode === "PAPER" ? "Paper ledger" : "Robinhood"} />
          <StatusRow label="Alpaca" value={desk.alpaca.configured ? "Paper connected" : "Not connected"} />
          <p className="text-xs leading-5 text-[var(--muted)]">{desk.alpaca.configured ? desk.alpaca.detail : desk.robinhood.detail}</p>
          {desk.session?.vwap ? <p className="text-sm">VWAP {formatPx(desk.session.vwap)}</p> : null}
          {desk.session?.standDown ? <p className="text-sm">{desk.session.standDown}</p> : null}
          {desk.triggerCaveat ? <p className="text-xs leading-5 text-[var(--muted)]">{desk.triggerCaveat}</p> : null}
        </Card>
      </section>
      <PositionBook desk={desk} />
      <Card>
        <CardTitle>Recent trades</CardTitle>
        <div className="mt-3 space-y-2">
          {desk.recentTrades.slice(0, 6).map((trade) => (
            <div key={trade.id} className="flex items-center justify-between gap-3 text-sm">
              <div className="flex items-center gap-2">
                <Badge>{trade.origin === "DEMO" ? "Sample" : trade.status}</Badge>
                <span>{trade.quantity} {trade.symbol}</span>
                <span className="text-[var(--muted)]">{trade.setup}</span>
              </div>
              <span className={trade.realizedPnlCents >= 0 ? "text-[var(--positive)]" : "text-[var(--negative)]"}>
                {formatUsd(trade.realizedPnlCents, true)}
              </span>
            </div>
          ))}
          {desk.recentTrades.length === 0 ? <p className="text-sm text-[var(--muted)]">No trades yet.</p> : null}
        </div>
      </Card>
    </div>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-[var(--muted)]">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}
