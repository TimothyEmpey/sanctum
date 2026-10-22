"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { LiveRefresh } from "@/components/live-refresh";
import { ThemeToggle } from "@/components/theme-toggle";
import { UrielMark } from "@/components/uriel-mark";
import { cn } from "@/lib/utils";

const links = [
  { href: "/", label: "Dashboard" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/logs", label: "Logs" },
  { href: "/pnl", label: "P&L" },
  { href: "/risk", label: "Risk" },
  { href: "/floor", label: "Floor" },
];

export function DeskShell({children,halt,urielPaused,sessionActive=false,accountControl}:{children:ReactNode;halt:boolean;urielPaused:boolean;sessionActive?:boolean;accountControl?:ReactNode}) {
  const pathname=usePathname(),params=useSearchParams();
  const asset=params.get("asset")==="ES"?"ES":"NQ";
  const query=`asset=${asset}`;
  const tone=halt?"halted":urielPaused?"paused":sessionActive?"live":"idle";
  const withQuery=(href:string)=>`${href}?${query}`;
  return (
    <>
      <LiveRefresh />
      <UrielMark tone={tone} pet="uriel" />
      <div className="mx-auto min-h-screen max-w-6xl px-4 pb-24 pt-5 md:pb-10 md:pt-6">
        <header className="mb-4 flex items-center justify-between gap-3 pr-28 sm:pr-36">
          <Link href={`/?${query}`} className="text-lg font-semibold tracking-tight">
            Uriel
          </Link>
          <nav className="hidden items-center gap-1 md:flex">
            {links.map((link) => {
              const active = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={withQuery(link.href)}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-sm",
                    active ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "text-[var(--muted)] hover:text-[var(--foreground)]",
                  )}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            {accountControl}
          </div>
        </header>
        <div className="mb-6 flex flex-wrap items-center gap-2 pr-28 sm:pr-36">
          <span className="text-sm text-[var(--muted)]">Futures</span>
          <span className="px-1 text-[var(--muted)]">/</span>
          {(["NQ","ES"] as const).map(symbol=>(
            <Link key={symbol} href={`${pathname}?asset=${symbol}`} className={chip(asset===symbol)}>{symbol}1!</Link>
          ))}
        </div>
        {children}
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-30 flex justify-around border-t border-[var(--border)] bg-[color-mix(in_oklab,var(--background)_88%,transparent)] px-2 py-2 backdrop-blur md:hidden">
        {links.map((link) => (
          <Link
            key={link.href}
            href={withQuery(link.href)}
            className={cn("rounded-full px-2 py-1 text-xs", pathname === link.href ? "text-[var(--primary)]" : "text-[var(--muted)]")}
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </>
  );
}

function chip(active: boolean) {
  return cn(
    "rounded-full border px-3 py-1 text-sm",
    active
      ? "border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)]"
      : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]",
  );
}
