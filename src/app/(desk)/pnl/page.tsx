import { PnlBars } from "@/components/charts";
import { BookBanner, Metric, moneyTone } from "@/components/desk-widgets";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { formatUsd } from "@/lib/market/time";
import { engineClosed, sampleClosed, summarizeRealized } from "@/lib/portfolio/pnl";
import { getDesk } from "@/server/desk";

export default async function PnlPage({
  searchParams,
}: {
  searchParams: Promise<{ book?: string; asset?: string }>;
}) {
  const desk = await getDesk(await searchParams);
  if (!desk) return <p>Seed the paper account before opening the desk.</p>;
  const sleeve = engineClosed(desk.recentTrades).filter((trade) => !trade.priorBook);
  const prior = engineClosed(desk.recentTrades).filter((trade) => trade.priorBook);
  const closed = sleeve;
  const samples = sampleClosed(desk.recentTrades);
  const { wins, losses, realized, grossWin, grossLoss, avgR } = summarizeRealized(closed);
  const byDay = new Map<string, number>();
  const ordered = [...closed].sort(
    (a, b) => new Date(a.closedAt ?? a.openedAt).getTime() - new Date(b.closedAt ?? b.openedAt).getTime(),
  );
  for (const trade of ordered) {
    const key = new Date(trade.closedAt ?? trade.openedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
    byDay.set(key, (byDay.get(key) ?? 0) + trade.realizedPnlCents);
  }
  const rows = [...byDay.entries()].map(([label, pnl]) => ({ label, pnl: pnl / 100 }));

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs uppercase tracking-[0.22em] text-[var(--muted)]">Results</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">P&L</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">{desk.assetLabel} since the $1,000 book. Portfolio equity is the shared book.</p>
      </div>
      <BookBanner mode={desk.mode} demo={desk.demo} brokerEquityCents={desk.brokerEquityCents} />
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Realized P&L" value={formatUsd(realized, true)} tone={moneyTone(realized)} hint={`${desk.workerName} fills in this book.`} />
        <Metric label="Win rate" value={closed.length ? `${Math.round((wins / closed.length) * 100)}%` : "—"} hint={`${wins} wins · ${losses} losses`} />
        <Metric label="Average R" value={closed.length ? avgR.toFixed(2) : "—"} />
        <Metric label="Profit factor" value={grossLoss ? (grossWin / grossLoss).toFixed(2) : "—"} />
      </section>
      <Card>
        <CardTitle>Daily realized</CardTitle>
        <div className="mt-4">
          <PnlBars rows={rows} />
        </div>
      </Card>
      <Card>
        <CardTitle>Closed trades</CardTitle>
        <div className="mt-3 space-y-3">
          {closed.length === 0 ? <p className="text-sm text-[var(--muted)]">No {desk.workerName} trades closed in this book yet.</p> : null}
          {closed.map((trade) => (
            <div key={trade.id} className="border-b border-[var(--border)] pb-3 text-sm last:border-0">
              <div className="flex items-center justify-between gap-3">
                <span>{trade.quantity} {trade.symbol} {trade.setup}</span>
                <span className={trade.realizedPnlCents >= 0 ? "text-[var(--positive)]" : "text-[var(--negative)]"}>
                  {formatUsd(trade.realizedPnlCents, true)}
                </span>
              </div>
              {trade.journal ? <p className="mt-1 text-xs text-[var(--muted)]">{trade.journal}</p> : null}
            </div>
          ))}
        </div>
      </Card>
      {prior.length > 0 ? (
        <Card>
          <CardTitle>Earlier book</CardTitle>
          <p className="mt-2 text-xs text-[var(--muted)]">These closes happened before the working book was set to $1,000. They stay in the log and are not in the realized total.</p>
          <div className="mt-3 space-y-3">
            {prior.map((trade) => (
              <div key={trade.id} className="flex items-center justify-between gap-3 border-b border-[var(--border)] pb-3 text-sm last:border-0">
                <span>{trade.quantity} {trade.symbol} {trade.setup}</span>
                <span className={trade.realizedPnlCents >= 0 ? "text-[var(--positive)]" : "text-[var(--negative)]"}>
                  {formatUsd(trade.realizedPnlCents, true)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      {samples.length > 0 ? (
        <Card>
          <CardTitle>Sample trades</CardTitle>
          <p className="mt-2 text-xs text-[var(--muted)]">These prints were never sent to Alpaca. They are not in the realized total.</p>
          <div className="mt-3 space-y-3">
            {samples.map((trade) => (
              <div key={trade.id} className="flex items-center justify-between gap-3 border-b border-[var(--border)] pb-3 text-sm last:border-0">
                <span className="flex items-center gap-2">
                  <Badge>Sample</Badge>
                  {trade.quantity} {trade.symbol} {trade.setup}
                </span>
                <span className={trade.realizedPnlCents >= 0 ? "text-[var(--positive)]" : "text-[var(--negative)]"}>
                  {formatUsd(trade.realizedPnlCents, true)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
