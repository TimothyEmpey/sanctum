# Uriel

Paper-first day-trading desk. A deterministic playbook proposes entries. A separate risk engine sizes them or refuses them. The broker is last.

Uriel trades SPY and QQQ. Fonzo trades BTC and ETH. Each asset has its own playbook. They share one $1,000 working book on the Alpaca paper account. That account is larger, it is not reset, and it is not the sizing book. Orders are long-only and size from cash. Other holdings are shown and never sold. Live Robinhood orders stay off until you explicitly arm them.

The site is one desk. Switch Stocks or Crypto, then one asset. `uriel` starts and stops the stock worker. `fonzo` starts and stops the crypto worker. `sanctum` starts and stops both. Stopping one worker leaves the site up while the other is still running.

This is trading software, not investment advice. You can lose money.

## Playbook

Last-half-hour SPY, from Gao, Han, Li, and Zhou, Journal of Financial Economics (2018). The signal is the return from the previous close to 10:00 ET. If it is positive, Uriel buys at 3:30 PM ET and sells at the cash close. If it is not, Uriel stays flat. The paper also shorts a down signal. This desk does not, so the live book is the long side only. On 1993–2013 data their long-and-short version returned about 6.67% a year before costs, Sharpe about 1.08. After the bid-ask spread that was about 4.46% a year. A long-only cash account is a smaller slice, and the sample ends in 2013. This is not a promise of profit. The stop is 2% under the entry because the desk will not send an order without one. There is no profit target. One buy a day. Shorts stay off.

QQQ uses that same clock. The 2018 paper reported the pattern in the most active ETFs, including the Nasdaq ETF. A 2026 replication on QQQ did not clear a 2 basis point round trip, so this is not a claim that QQQ earns the SPY sample. BTC and ETH use a UTC last-half-hour: the 00:00–00:30 return is the signal, the buy is 23:30 UTC, and the sell is 24:00 UTC. Bitcoin follows Shen, Urquhart, and Zhu, Financial Review (2022). Ethereum follows the same clock because Wen, Bouri, Xu, and Zhao (2022) found intraday predictability there. Fonzo uses the UTC day because crypto has no cash open. That is not a reproduction of their volume clock, and it is not a promised return.

The account limits are 2% risk per trade, 5% daily loss, 5% weekly loss, 5% drawdown from peak, 2 open positions, and 4% combined open risk, all on the shared $1,000 book. SPY, QQQ, BTC, and ETH are each designated 25% of that equity, and an order cannot spend another asset share. Each asset gets 1 trade a day. Stops are required before entry and cannot be widened. Size is `floor(equity × 2% / stop distance)`, then cut to that share and to cash. After a loss, the next buy is capped at that losing size. The working book is under $25,000, so stock day trades stop at 3 in 5 business days. Crypto orders do not add to that count.

The model is not on the order path. If `XAI_API_KEY` is set, Grok writes one journal sentence after a closed trade, at most three times a day.

## Why the worker is cheap to leave on

The hot path is a Node loop: quotes, the playbook, the risk engine, then the paper ledger. It polls about every 20 seconds from 9:25 ET through the flatten. While the market is closed, including overnight, weekends, and NYSE holidays, it heartbeats on the hour in ET and wakes at 9:25 ET for the next session. No model call is required for it to trade.

US equities are not a 24-hour market. The process stays up. It sends the buy at 3:30 PM ET (12:30 PM on the two 2026 early closes) and sells at the cash close. A position left over from an older playbook is still closed at 3:50 PM ET.

## Robinhood

Alpaca paper is the test broker. Set `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`, and `APCA_API_BASE_URL=https://paper-api.alpaca.markets`. The client refuses any other host. The $1,000 working book is what the desk sizes and displays. Alpaca equity is stored beside it. Stock orders are brackets. Crypto orders are a limit buy plus a separate stop, with no take-profit. The risk engine approves both before anything is sent.

Robinhood does not give an agent the main brokerage account. The official path is a separate agentic account connected at `https://agent.robinhood.com/mcp/trading`. Put the bearer token in `ROBINHOOD_MCP_TOKEN` when you have one.

Live orders also require `LIVE_TRADING=true` and `ROBINHOOD_ORDER_CONFIRMED=true`. Until those are set, Uriel keeps using the paper ledger. The symbol firewall runs before any order function, confirmed or not.

Postgres is the ledger because the app uses Prisma against relational trades, orders, and snapshots. Cloudflare D1 is not Postgres. Run Postgres locally, or point `DATABASE_URL` at Neon, Supabase, or Postgres behind Cloudflare Hyperdrive. The always-on loop is a normal Node process, not a Worker.

## Run

```bash
cp .env.example .env
# set DATABASE_URL, AUTH_SECRET, and URIEL_OPERATOR_PASSWORD

brew install postgresql@16
bash scripts/postgres.sh
npx prisma migrate dev --name init
npx prisma db seed
npm run dev
npm run worker
```

Sign in at `http://localhost:3000` with `URIEL_OPERATOR_EMAIL` and `URIEL_OPERATOR_PASSWORD`.

`docker compose up -d` is the alternative database if you already use Docker. Then set `DATABASE_URL=postgresql://uriel:uriel@localhost:5432/uriel`.

## Tests

```bash
npm test
```

The risk engine, stop rule, symbol firewall, calendar, and opening-range rules are covered without a database.
