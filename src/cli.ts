import { STOCK_SYMBOLS, CRYPTO_SYMBOLS, TRADABLE_SYMBOLS, WORKING_BOOK_CENTS, type DeskName } from "@/lib/assets";
import { etParts, formatUsd } from "@/lib/market/time";
import { alpacaPaperConfigured, getPaperBalances } from "@/server/alpaca";
import { prisma } from "@/server/db";

function deskName(): DeskName {
  const raw = (process.env.SANCTUM_DESK ?? "uriel").toLowerCase();
  if (raw === "fonzo" || raw === "sanctum") return raw;
  return "uriel";
}

function usage(name: string) {
  const start = name === "sanctum" ? "start both workers and the desk" : "start this worker and the desk";
  const stop = name === "sanctum" ? "stop both workers and the desk" : "stop this worker";
  return `${name} portfolio              working-book equity and cash
${name} balance                working-book equity and cash
${name} performance -today     today's profit or loss
${name} performance -all       all-time profit or loss
${name} start                  ${start}
${name} stop                   ${stop}`;
}

function line(label: string, value: string) {
  return `${label.padEnd(12)}${value}`;
}

function symbolsFor(desk: DeskName) {
  if (desk === "fonzo") return [...CRYPTO_SYMBOLS];
  if (desk === "uriel") return [...STOCK_SYMBOLS];
  return [...TRADABLE_SYMBOLS];
}

async function snapshot() {
  const account = await prisma.account.findFirst();
  if (!account) {
    throw new Error("No account is stored. Start Postgres, then run the worker once.");
  }
  let brokerEquity = account.brokerEquityCents;
  let brokerCash = account.brokerCashCents;
  if (alpacaPaperConfigured()) {
    try {
      const live = await getPaperBalances();
      brokerEquity = live.equityCents;
      brokerCash = live.cashCents;
    } catch {
      // Keep the last stored broker footnote when the paper host is unreachable.
    }
  }
  return {
    accountId: account.id,
    equityCents: account.equityCents,
    cashCents: account.cashCents,
    brokerEquity,
    brokerCash,
    dayPnlCents: account.equityCents - account.dayStartEquityCents,
    allTimePnlCents: account.equityCents - WORKING_BOOK_CENTS,
    bookResetAt: account.bookResetAt,
    session: account.dayStartDate,
  };
}

async function balance() {
  const book = await snapshot();
  console.log(line("Portfolio", formatUsd(book.equityCents)));
  console.log(line("Cash", formatUsd(book.cashCents)));
  if (book.brokerEquity != null) console.log(line("Broker", formatUsd(book.brokerEquity)));
  if (book.brokerCash != null) console.log(line("Broker cash", formatUsd(book.brokerCash)));
}

async function deskPnl(desk: DeskName, span: "today" | "all") {
  const book = await snapshot();
  if (desk === "sanctum") return span === "all" ? book.allTimePnlCents : book.dayPnlCents;
  const now = new Date();
  const todayKey = desk === "fonzo" ? now.toISOString().slice(0, 10) : etParts(now).dateKey;
  const trades = await prisma.trade.findMany({
    where: {
      accountId: book.accountId,
      origin: "ENGINE",
      symbol: { in: symbolsFor(desk) },
      ...(book.bookResetAt ? { openedAt: { gte: book.bookResetAt } } : {}),
    },
  });
  let realized = 0;
  for (const trade of trades) {
    if (trade.status !== "CLOSED" || !trade.closedAt) continue;
    if (span === "today") {
      const closedKey = desk === "fonzo" ? trade.closedAt.toISOString().slice(0, 10) : etParts(trade.closedAt).dateKey;
      if (closedKey !== todayKey) continue;
    }
    realized += trade.realizedPnlCents;
  }
  let unrealized = 0;
  for (const trade of trades) {
    if (trade.status !== "OPEN") continue;
    const bar = await prisma.marketBar.findFirst({
      where: { accountId: book.accountId, symbol: trade.symbol },
      orderBy: { ts: "desc" },
    });
    const mark = bar?.close ?? trade.entryPrice;
    const sign = trade.side === "LONG" ? 1 : -1;
    unrealized += Math.round((mark - trade.entryPrice) * trade.quantity * sign * 100);
  }
  return realized + unrealized;
}

async function performance(desk: DeskName, span: "today" | "all") {
  const book = await snapshot();
  const pnl = await deskPnl(desk, span);
  if (span === "all") {
    console.log(line("All time", formatUsd(pnl, true)));
    console.log(line("Portfolio", formatUsd(book.equityCents)));
    console.log(line("Started", formatUsd(WORKING_BOOK_CENTS)));
    return;
  }
  console.log(line("Today", formatUsd(pnl, true)));
  console.log(line("Portfolio", formatUsd(book.equityCents)));
  console.log(line("Started", formatUsd(book.equityCents - book.dayPnlCents)));
  if (book.session) console.log(line("Session", book.session));
}

function performanceSpan(args: string[]) {
  const flags = args.map((arg) => arg.toLowerCase());
  const today = flags.some((flag) => flag === "-today" || flag === "--today" || flag === "today");
  const all = flags.some((flag) => flag === "-all" || flag === "--all" || flag === "all");
  if (today && all) throw new Error("Choose one of -today or -all.");
  if (today) return "today" as const;
  if (all) return "all" as const;
  return null;
}

async function main() {
  const desk = deskName();
  const name = desk;
  const command = (process.argv[2] ?? "").toLowerCase();
  if (command === "balance" || command === "portfolio") {
    await balance();
    return;
  }
  if (command === "today") {
    await performance(desk, "today");
    return;
  }
  if (command === "performance") {
    const span = performanceSpan(process.argv.slice(3));
    if (!span) {
      console.log(usage(name));
      if (process.argv.length > 3) throw new Error(`Unknown option "${process.argv[3]}".`);
      return;
    }
    await performance(desk, span);
    return;
  }
  console.log(usage(name));
  if (command && command !== "help" && command !== "--help" && command !== "-h") {
    throw new Error(`Unknown command "${process.argv[2]}".`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
