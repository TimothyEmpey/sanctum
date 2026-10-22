# MFFU / Tradovate connection — implementation status

Updated 2026-10-22. Target: one Uriel engine on macOS; separate market-data and execution transports.

## Implemented
- `src/integrations/crosstrade.ts`: server-side GET-only client for documented direct Tradovate status/accounts/snapshot routes. Redirects are rejected, requests time out, provider errors are redacted. No order methods.
- `scripts/check-crosstrade.ts`: explicit read-only check; it never prints credentials or account payloads. Nothing invokes it automatically.
- `scripts/databento_feed.py`: opt-in CME minute-bar subscription through the official Python SDK. Uses explicit raw dated contracts, validates configured expiry and symbol month/year, pairs NQ/ES by minute, rejects malformed bars, never fabricates missing candles, atomically publishes the existing feed format. No external orders. No automatic backfill or reconnect recovery yet.
- `src/core/price-alignment.ts`: unit-tested prerequisite comparator for same-contract, same-price-type observations with freshness, clock, tick and deviation checks. NOT yet wired into execution: external trading is unavailable. Thresholds must be selected from observations, not treated as validated defaults.

## Not ready / dependencies
- No accounts authenticated, subscriptions purchased, live data received or orders sent.
- CrossTrade's direct Tradovate API has no quote/candle stream. A licensed Tradovate reference for automated parity checking is still unresolved. Do not label prices verified without that evidence.
- Databento minute bars are aggregated using trade receive time. Tradovate bars may use a different boundary convention. Price agreement does not prove identical candles. Test OHLC agreement and boundary trades before using this schema for signals; a trade-event aggregation implementation may be needed.
- Collector has no historical warmup yet. It starts collecting at subscription time. Existing local worker can consume its feed, but stays a LOCAL fill simulator, not broker paper trading. Existing chart/strategy share the same ledger bars. Feed collection alone does not update the ledger.
- Existing default research limits are NOT an MFFU plan profile. Do not trade an evaluation with those defaults.
- Broker-hosted paper order adapter, journal reconciliation, partial-fill protection, disconnect recovery, verified news calendar, account selection and funded-stage entitlement remain to implement and test.
- MFFU actual-live promotion is distinct from a payout-eligible sim-funded account. Vendor documentation of demo prop accounts does not verify actual-live routing.

## Accounts and costs to resolve before activation
1. Databento: account/API key and GLBX.MDP3 CME live entitlement. Published Standard price $199/month; confirm personal-use eligibility for automated prop trading and required schemas in checkout. Signup historical credits do not cover live subscriptions.
2. CrossTrade: Pro REST API access ($49/month published monthly price), bearer token, eligible Tradovate Demo identity linked by the user via OAuth. Its advertised trial may be used only if it includes the required API access. Never send Tradovate passwords to Uriel.
3. Tradovate demo login for broker-paper integration testing. Do not buy MFFU just to obtain a login before confirming demo eligibility and data licensing.
Three subscription months at these published rates: $744, leaving $256 of the $1,000 ceiling for evaluations, data/licensing extras and other charges. This is not an all-in quote. Do not start annual plans.

## Local setup (only after account/entitlement verification)
Keep secrets in ignored local environment files, never chat or client-side NEXT_PUBLIC variables.
- `CROSSTRADE_API_TOKEN`: CrossTrade bearer token.
- `DATABENTO_API_KEY`: Databento market-data key.

Read-only check: load the local token into the process environment, then `node --import tsx scripts/check-crosstrade.ts`.
Collector: create a separate Python virtual environment, install the official `databento` package, then run `python scripts/databento_feed.py --help`. Supply the verified provider NQ and ES raw symbols with `--nq-symbol` and `--es-symbol`, and a reviewed futures configuration. No expiry is guessed. Keep output separate from any historical validation run.
Do not run the legacy local worker thinking it places broker paper orders.

## Sources
- https://crosstrade.io/docs/api/tradovate/overview
- https://crosstrade.io/docs/tradovate/linking-your-account
- https://crosstrade.io/prop-firms/my-funded-futures
- https://crosstrade.io/pricing
- https://databento.com/pricing
- https://databento.com/docs/examples/symbology/live-symbol-mapping?lang=python
- https://databento.com/docs/schemas/ohlcv
- https://help.myfundedfutures.com/en/articles/8444599-fair-play-and-prohibited-trading-practices
