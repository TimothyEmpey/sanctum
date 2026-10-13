# Uriel

Paper-first SPY day-trading desk. A deterministic playbook proposes entries. A separate risk engine sizes them or refuses them. The broker is last.

Uriel trades SPY only, and only shares the agent bought. Other holdings are shown and never sold. Reserved SPY that was already in the book is not sold either. Live Robinhood orders stay off until you explicitly arm them.

This is trading software, not investment advice. You can lose money.

## Playbook

Trend pullback on SPY. Price holds above a rising VWAP. A 5-minute bar dips and closes back up. One buy a day. The stop is at least 0.25% under the entry, or beyond the dip if the dip is deeper. The target is 1.5 times that distance, about 0.4% when the stop is at the minimum. Recent sessions have ranged about 0.5% to 0.9%, so the target sits inside a normal day. A deep dip is not skipped. The risk engine buys fewer shares. Shorts stay off. Flat before the close.

The account limits are 2% risk per trade, 5% daily loss, 5% weekly loss, 5% drawdown from peak, 2 open positions, 4% combined open risk, and 1 trade a day. Stops are required before entry and cannot be widened. Size is `floor(equity × 2% / stop distance)`, then cut to cash. After a loss, the next buy is capped at that losing size.

The model is not on the order path. If `XAI_API_KEY` is set, Grok writes one journal sentence after a closed trade, at most three times a day.

## Why the worker is cheap to leave on

The hot path is a Node loop: quotes, the playbook, the risk engine, then the paper ledger. It polls about every 20 seconds from 9:25 ET through the flatten. While the market is closed, including overnight, weekends, and NYSE holidays, it heartbeats on the hour in ET and wakes at 9:25 ET for the next session. No model call is required for it to trade.

US equities are not a 24-hour market. The process stays up. It only sends orders from 9:50 to 15:30 ET (12:30 on the two 2026 early closes) and flattens by 15:50 ET.

## Robinhood

Alpaca paper is the test broker. Set `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`, and `APCA_API_BASE_URL=https://paper-api.alpaca.markets`. The client refuses any other host. Uriel reads that account’s equity and cash, ignores margin buying power, and sends SPY brackets only after the risk engine approves them.

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
