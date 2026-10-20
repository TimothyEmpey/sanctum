import Link from "next/link";
import { signOutDesk } from "@/app/actions";
import { PriceChart } from "@/components/charts";
import { FloorPets } from "@/components/floor-pets";
import { LiveRefresh } from "@/components/live-refresh";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { formatPx, formatQty, formatUsd } from "@/lib/market/time";
import { MOMENTUM_SETUP } from "@/lib/strategy/intraday-momentum";
import { getFloor } from "@/server/floor";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

function positionLine(panel: {
  label: string;
  openTrades: Array<{ side: string; quantity: number; entryPrice: number; stopPrice: number; targetPrice: number; setup: string; unrealizedCents: number }>;
  baseline: Array<{ quantity: number; averagePrice: number; marketValueCents: number }>;
}) {
  const trade = panel.openTrades[0];
  if (trade) {
    const exit =
      trade.setup === MOMENTUM_SETUP ? "exit at the cash close" : `target ${formatPx(trade.targetPrice)}`;
    const extra = panel.openTrades.length > 1 ? ` · +${panel.openTrades.length - 1} more` : "";
    return `${trade.side} ${formatQty(trade.quantity)} · entry ${formatPx(trade.entryPrice)} · stop ${formatPx(trade.stopPrice)} · ${exit} · ${formatUsd(trade.unrealizedCents, true)}${extra}`;
  }
  const holding = panel.baseline[0];
  if (holding) {
    return `${formatQty(holding.quantity)} reserved · avg ${formatPx(holding.averagePrice)} · ${formatUsd(holding.marketValueCents)}`;
  }
  return `No open ${panel.label} position.`;
}

const links = [
  { href: "/", label: "Dashboard" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/logs", label: "Logs" },
  { href: "/pnl", label: "P&L" },
  { href: "/risk", label: "Risk" },
  { href: "/floor", label: "Floor" },
];

export default async function FloorPage() {
  const floor = await getFloor();
  if (!floor) return <p className="p-6">Seed the paper account before opening the floor.</p>;
  const fonzoTone = floor.halted ? "halted" : floor.fonzoPaused ? "paused" : "live";
  const urielTone = floor.halted ? "halted" : floor.urielPaused ? "paused" : "live";

  return (
    <>
      <LiveRefresh />
      <FloorPets fonzoTone={fonzoTone} urielTone={urielTone} />
      <div className="flex h-dvh flex-col overflow-hidden px-3 pb-16 pt-2 md:px-4 md:pb-3">
        <header className="mb-2 flex h-10 shrink-0 items-center justify-between gap-2 pl-24 pr-24 sm:pl-32 sm:pr-32">
          <div>
            <h1 className="text-sm font-semibold tracking-tight">Floor</h1>
          </div>
          <nav className="hidden items-center gap-1 md:flex">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  "rounded-full px-3 py-1.5 text-sm",
                  link.href === "/floor" ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "text-[var(--muted)] hover:text-[var(--foreground)]",
                )}
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <form action={signOutDesk}>
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-2">
          {floor.panels.map((panel) => (
            <Card key={panel.symbol} className="flex min-h-0 min-w-0 flex-col overflow-hidden p-2 md:p-2.5">
              <div className="mb-1 flex shrink-0 items-baseline justify-between gap-2">
                <CardTitle>
                  {panel.label}
                  <span className="ml-2 font-normal">{panel.workerName}</span>
                </CardTitle>
                <p className="tabular text-sm font-semibold">{panel.mark == null ? "—" : formatPx(panel.mark)}</p>
              </div>
              <div className="min-h-0 flex-1">
                <PriceChart key={panel.symbol} symbol={panel.label} daily={panel.bars.daily} minute={panel.bars.minute} fit />
              </div>
              <p className="mt-1 shrink-0 truncate text-xs text-[var(--muted)]">{positionLine(panel)}</p>
              {panel.caveat ? <p className="shrink-0 truncate text-[11px] leading-4 text-[var(--muted)]">{panel.caveat}</p> : null}
            </Card>
          ))}
        </div>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-30 flex justify-around border-t border-[var(--border)] bg-[color-mix(in_oklab,var(--background)_88%,transparent)] px-2 py-2 backdrop-blur md:hidden">
        {links.map((link) => (
          <Link key={link.href} href={link.href} className={cn("rounded-full px-2 py-1 text-xs", link.href === "/floor" ? "text-[var(--primary)]" : "text-[var(--muted)]")}>
            {link.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
