# Uriel

Paper-first day-trading desk. A deterministic playbook proposes entries. A separate risk engine sizes them or refuses them. The broker is last.

Uriel trades SPY and NQ. Fonzo trades BTC and ETH. Each asset has its own playbook. They share one $1,000 working book on the Alpaca paper account. That account is larger, it is not reset, and it is not the sizing book. Orders are long-only and size from cash. Other holdings are shown and never sold. Live Robinhood orders stay off until you explicitly arm them.

The site is one desk. Switch Stocks or Crypto, then one asset. `uriel` starts and stops the stock worker. `fonzo` starts and stops the crypto worker. `sanctum` starts and stops both. Stopping one worker leaves the site up while the other is still running.

This is trading software, not investment advice. You can lose money.

## Playbook

SPY follows the chart. A long is a 15-minute sweep of a swing low that closes back above the high in place, or a 15-minute uptrend that retraces on the 5-minute and closes back above that high. The dip cannot break the 15-minute low. The stop is the sweep or retrace low. The target is the next high, or one times the risk when no high is drawn. Shorts stay off. Each fresh long can be taken after the prior position is closed, from the open until the cash flatten. This is not a promise of profit.

NQ is Nasdaq-100 futures. The long setup sweeps the prior day's low, breaks five-minute structure up with the S&P futures by 10:20 ET, then buys the one-minute continuation from 9:30 to 10:30 ET. Shorts stay off. The stop is the retrace low and the target is the next high. The position is also out at the cash close. This is not a claim on anyone's reported win rate. The buy is a fraction of the quoted price, at least $1, so the 25% share can fund it. Alpaca paper has no Nasdaq contract, so that fraction is held on the working book. BTC and ETH use a UTC last-half-hour: the 00:00–00:30 return is the signal, the buy is 23:30 UTC, and the sell is 24:00 UTC. Fonzo polls every 20 seconds from 23:25 UTC through 00:40 UTC. An earlier hour wakes at 23:25 instead of sleeping through that buy. Bitcoin follows Shen, Urquhart, and Zhu, Financial Review (2022). Ethereum follows the same clock because Wen, Bouri, Xu, and Zhao (2022) found intraday predictability there. Fonzo uses the UTC day because crypto has no cash open. That is not a reproduction of their volume clock, and it is not a promised return.

The account limits are 2% risk per trade, 5% daily loss, 5% weekly loss, and 5% drawdown from peak, on the shared $1,000 book. Uriel and Fonzo each have their own 2 open positions and 4% open risk. One desk's positions do not count against the other. SPY, NQ, BTC, and ETH are each designated 25% of that equity, and an order cannot spend another asset share. NQ, BTC, and ETH get 1 trade a day. SPY can take each new long after the prior position is closed. Stops are required before entry and cannot be widened. Size is `floor(equity × 2% / stop distance)`, then cut to that share and to cash. Uriel buys a fraction of a share, down to a millionth, and Robinhood's minimum is $1. After a loss, an NQ or crypto buy stays at or below that losing size. A new SPY long is sized from its own stop.

The model is not on the order path. If `XAI_API_KEY` is set, Grok writes one journal sentence after a closed trade, at most three times a day.

## Why the worker is cheap to leave on

The hot path is a Node loop: quotes, the playbook, the risk engine, then the paper ledger. It polls about every 20 seconds from 9:25 ET through the flatten. While the market is closed, including overnight, weekends, and NYSE holidays, it heartbeats on the hour in ET and wakes at 9:25 ET for the next session. No model call is required for it to trade.

US equities are not a 24-hour market. The process stays up. SPY looks for a long from the cash open until the cash flatten, including the two 2026 early closes. NQ looks for its long continuation from 9:30 to 10:30 ET. A position left over from an older playbook is still closed at 3:50 PM ET. An open SPY or NQ trade from the current playbook is kept through that cutoff and sold at the target, the stop, or the cash close.

## Robinhood

Alpaca paper is the test broker. Set `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`, and `APCA_API_BASE_URL=https://paper-api.alpaca.markets`. The client refuses any other host. The $1,000 working book is what the desk sizes and displays. Alpaca equity is stored beside it. A whole share is sent as a bracket. A fractional SPY buy is a simple day limit, the stop is its own day order, and Uriel sells the target. Crypto orders are a limit buy plus a separate stop, with no take-profit. The risk engine approves both before anything is sent.

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
