import { BookBanner, FillTape, PositionBook } from "@/components/desk-widgets";
import { Card, CardTitle } from "@/components/ui/card";
import { getDesk } from "@/server/desk";

function withoutRetiredSymbol(message: string) {
  return message.replace(/\s*QQQ\s+[0-9,]+\.?[0-9]*\.?/g, "").replace(/[ ]{2,}/g, " ").trim();
}

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ book?: string; asset?: string }>;
}) {
  const desk = await getDesk(await searchParams);
  if (!desk) return <p>Seed the paper account before opening the desk.</p>;
  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs uppercase tracking-[0.22em] text-[var(--muted)]">{desk.assetLabel} ledger</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Logs</h1>
      </div>
      <BookBanner mode={desk.mode} demo={desk.demo} brokerEquityCents={desk.brokerEquityCents} />
      <PositionBook desk={desk} includeUntouchable={false} />
      <FillTape desk={desk} />
      <Card>
        <CardTitle>Desk notes</CardTitle>
        <div className="mt-3 space-y-3">
          {desk.events.map((event) => (
            <div key={event.id} className="text-sm">
              <p>{withoutRetiredSymbol(event.message)}</p>
              <p className="text-xs text-[var(--muted)]">
                {event.kind} · {new Date(event.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
