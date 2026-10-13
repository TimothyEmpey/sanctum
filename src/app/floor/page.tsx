import Link from "next/link";
import { signOutDesk } from "@/app/actions";
import { PriceChart } from "@/components/charts";
import { FloorPets } from "@/components/floor-pets";
import { LiveRefresh } from "@/components/live-refresh";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { formatPx, formatQty, formatUsd } from "@/lib/market/time";
import { MOMENTUM_SETUP } from "@/lib/strategy/intraday-momentum";
import { getFloor } from "@/server/floor";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

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
      <div className="mx-auto min-h-screen max-w-6xl px-4 pb-24 pt-5 md:pb-10 md:pt-6">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3 pl-28 pr-28 sm:pl-36 sm:pr-36">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-[var(--muted)]">Sanctum</p>
            <h1 className="text-lg font-semibold tracking-tight">Floor</h1>
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
        <div className="grid gap-4 lg:grid-cols-2">
          {floor.panels.map((panel) => (
            <Card key={panel.symbol} className="min-w-0">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <div>
                  <CardTitle>{panel.label}</CardTitle>
                  <p className="mt-1 text-xs text-[var(--muted)]">{panel.workerName}</p>
                </div>
                <p className="tabular text-lg font-semibold">{panel.mark == null ? "—" : formatPx(panel.mark)}</p>
              </div>
              <PriceChart key={panel.symbol} symbol={panel.label} daily={panel.bars.daily} minute={panel.bars.minute} />
              <div className="mt-4 border-t border-[var(--border)] pt-4">
                <h3 className="text-sm font-medium text-[var(--muted)]">Open positions</h3>
                <div className="mt-3 space-y-2">
                  {panel.openTrades.length === 0 && panel.baseline.length === 0 ? (
                    <p className="text-sm text-[var(--muted)]">{`No open ${panel.label} position.`}</p>
                  ) : null}
                  {panel.openTrades.map((trade) => (
                    <div key={trade.id} className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--border)] px-3 py-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{trade.symbol}</span>
                          <Badge>{panel.workerName}</Badge>
                        </div>
                        <p className="mt-1 text-xs text-[var(--muted)]">
                          {trade.side} {formatQty(trade.quantity)} · entry {formatPx(trade.entryPrice)} · stop {formatPx(trade.stopPrice)} ·{" "}
                          {trade.setup === MOMENTUM_SETUP
                            ? "exit at the cash close"
                            : trade.setup === "CRYPTO_LAST_HALF"
                              ? "exit at 24:00 UTC"
                              : `target ${formatPx(trade.targetPrice)}`}
                        </p>
                      </div>
                      <p className={`tabular text-sm font-medium ${trade.unrealizedCents > 0 ? "text-[var(--positive)]" : trade.unrealizedCents < 0 ? "text-[var(--negative)]" : ""}`}>
                        {formatUsd(trade.unrealizedCents, true)}
                      </p>
                    </div>
                  ))}
                  {panel.baseline.map((holding) => (
                    <div key={holding.symbol} className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--border)] px-3 py-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{holding.symbol}</span>
                          <Badge>Reserved</Badge>
                        </div>
                        <p className="mt-1 text-xs text-[var(--muted)]">
                          {formatQty(holding.quantity)} shares reserved · avg {formatPx(holding.averagePrice)} · last {formatPx(holding.marketPrice)}
                        </p>
                      </div>
                      <p className="tabular text-sm font-medium">{formatUsd(holding.marketValueCents)}</p>
                    </div>
                  ))}
                </div>
              </div>
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
