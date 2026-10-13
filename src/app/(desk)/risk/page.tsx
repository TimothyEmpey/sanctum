import { flattenNow, togglePause } from "@/app/actions";
import { Metric } from "@/components/desk-widgets";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { formatUsd } from "@/lib/market/time";
import { getDesk } from "@/server/desk";

export default async function RiskPage({
  searchParams,
}: {
  searchParams: Promise<{ book?: string; asset?: string }>;
}) {
  const desk = await getDesk(await searchParams);
  if (!desk) return <p>Seed the paper account before opening the desk.</p>;
  const meters = [
    ["Per trade", `${desk.limits.maxRiskPerTrade * 100}%`],
    ["Daily loss", `${desk.limits.maxDailyLoss * 100}%`],
    ["Weekly loss", `${desk.limits.maxWeeklyLoss * 100}%`],
    ["Peak drawdown", `${desk.limits.maxDrawdownFromPeak * 100}%`],
    ["Open positions", String(desk.limits.maxOpenPositions)],
    ["Open risk", `${desk.limits.maxTotalOpenRisk * 100}%`],
    ["Trades / day", String(desk.limits.maxTradesPerDay)],
  ];

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs uppercase tracking-[0.22em] text-[var(--muted)]">Guardrails</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Risk</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--muted)]">
          {desk.workerName} proposes. The risk engine sizes and can refuse. Nothing reaches the broker without a stop and a symbol check. Loss limits use the shared $1,000 book.
        </p>
      </div>
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Daily room" value={formatUsd(desk.dailyLossRemainingCents)} />
        <Metric label="Weekly room" value={formatUsd(desk.weeklyLossRemainingCents)} />
        <Metric label="Drawdown" value={`${(desk.drawdown * 100).toFixed(2)}%`} hint="Halt at 5.0% from peak" />
        <Metric label="Open risk used" value={formatUsd(desk.openRiskCents)} hint={`of ${formatUsd(desk.openRiskLimitCents)}`} />
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Limits</CardTitle>
          <dl className="mt-3 space-y-2 text-sm">
            {meters.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="text-[var(--muted)]">{label}</dt>
                <dd className="font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card>
          <CardTitle>Controls</CardTitle>
          <p className="mt-2 text-sm">{desk.haltReason ?? "No halt is active."}</p>
          <p className="mt-2 text-sm text-[var(--muted)]">
            {desk.paused ? `${desk.workerName} is paused.` : `${desk.workerName} can take a new entry inside the window.`}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <form action={togglePause}>
              <input type="hidden" name="desk" value={desk.deskName} />
              <Button type="submit">{desk.paused ? `Resume ${desk.workerName}` : `Pause ${desk.workerName}`}</Button>
            </form>
            <form action={flattenNow}>
              <input type="hidden" name="symbol" value={desk.symbol} />
              <Button type="submit" variant="outline">Flatten {desk.assetLabel}</Button>
            </form>
          </div>
          <p className="mt-4 text-xs leading-5 text-[var(--muted)]">{desk.alpaca.configured ? desk.alpaca.detail : desk.robinhood.detail}</p>
        </Card>
      </div>
      <Card>
        <CardTitle>Playbook</CardTitle>
        <p className="mt-3 text-sm leading-6">{desk.playbook}</p>
        <ul className="mt-4 space-y-2 text-sm">
          {desk.rules.map((rule) => (
            <li key={rule} className="rounded-2xl border border-[var(--border)] px-3 py-2">{rule}</li>
          ))}
        </ul>
      </Card>
      <Card>
        <CardTitle>Recent risk decisions</CardTitle>
        <div className="mt-3 space-y-2 text-sm">
          {desk.decisions.length === 0 ? <p className="text-[var(--muted)]">No proposals yet.</p> : null}
          {desk.decisions.map((decision) => (
            <p key={decision.id}>
              <span className="font-medium">{decision.approved ? "Approved" : "Blocked"}.</span> {decision.reasons.join(" ")}
            </p>
          ))}
        </div>
      </Card>
    </div>
  );
}
