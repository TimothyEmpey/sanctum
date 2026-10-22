# Futures integration into the original Uriel UI

The original purple light/dark themes, Geist fonts, Uriel sprite, cards, chart renderer, navigation and page URLs are retained. Dashboard, Portfolio, Logs, P&L, Risk and Floor now read the futures ledger. Floor has two NQ/ES panels. Stocks/Crypto and Fonzo are removed from active navigation and the Sanctum start path.

The original login, credentials, database and historical trades remain intact. The new simulator uses `data/futures`, `futures.config.json`, and `data/futures/feed.json` by default. No old account history is represented as futures performance. Existing historical tables and legacy source are retained for recovery.

`uriel start` now starts the futures simulator and the existing desk. `sanctum start` is an alias for that same single worker. `uriel status`, `logs`, `pause`, `resume` and `flatten` target the futures ledger/queue. The controls cannot place broker orders. No worker or account connection was started as part of this integration. `fonzo start` is retired; stop remains available for cleanup of a previously started process.

Synthetic feeds and saved synthetic ledgers are rejected by the trading desk. There is no example-data startup. The next integration requires an entitled real-time futures data source and a broker paper account; neither is currently connected.

Optional database mirroring now requires `URIEL_AUDIT_DATABASE_URL`; the application's existing `DATABASE_URL` is not reused automatically. A new additive FuturesRun schema model is included, but no database migration is run. If enabling the optional mirror later, review and apply an additive migration to the intended separate database first.
