import { EquityChart } from "@/components/charts";
import { BookBanner, PositionBook } from "@/components/desk-widgets";
import { Card, CardTitle } from "@/components/ui/card";
import { getDesk } from "@/server/desk";

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<{ book?: string; asset?: string }>;
}) {
  const desk = await getDesk(await searchParams);
  if (!desk) return <p>Seed the paper account before opening the desk.</p>;
  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs uppercase tracking-[0.22em] text-[var(--muted)]">{desk.assetLabel} balances</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Portfolio</h1>
      </div>
      <BookBanner mode={desk.mode} demo={desk.demo} brokerEquityCents={desk.brokerEquityCents} />
      <Card>
        <CardTitle>Equity</CardTitle>
        <div className="mt-4">
          <EquityChart points={desk.snapshots} />
        </div>
      </Card>
      <PositionBook desk={desk} />
    </div>
  );
}
