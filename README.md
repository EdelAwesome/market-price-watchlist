# Market Price Watchlist

A markets watchlist + price-alert web app built to demonstrate real backend engineering, not a
fetch-and-display ticker. The two things it takes seriously:

1. **Returns are computed correctly under cashflows.** Positions and P&L are *derived* from a
   transaction ledger — never a stored `shares` number — and the money-weighted return is a real
   XIRR, not `(value − cost) / cost`.
2. **Alerts are a stateful, idempotent system.** An alert is a state machine with a
   database-enforced fire-once guarantee that holds across concurrent worker processes.

The backend is the point; the frontend is a deliberately minimal single page over the API.

---

## Architecture

Two **separate processes** plus Postgres and Redis:

```
  browser ──HTTP──▶  web (Fastify)  ──┐                ┌──▶  Alpaca Market Data (quotes only)
   (static SPA)      REST + SPA       ├─ Postgres ─────┤
                                      │  (source of    │
                     worker (BullMQ) ─┘   truth)       └──▶  Resend (email)
                     scheduler + queues──┐
                                         └── Redis (queue db0 + quote cache db1)
```

- **web** — auth, CRUD, analytics, and serves the SPA. Reads quotes **through the cache**, never
  the provider on the hot path. Does not run the scheduler.
- **worker** — a repeatable BullMQ job runs the poll cycle (dedup symbols → fetch → evaluate the
  alert FSM → enqueue emails); a second queue sends emails with retry/backoff.
- **Postgres** — durable source of truth. The transaction ledger is authoritative.
- **Redis** — BullMQ (db 0, no eviction) **and** the short-TTL quote cache (db 1), kept on
  separate logical DBs so cache pressure can never evict queued jobs.

The market-data provider sits behind a `QuoteProvider` interface (Alpaca is the only impl);
the quote cache sits behind a `CacheStore` interface (in-memory for tests, Redis in production).

---

## Setup & run

Requires Node ≥ 20. Copy the env template and fill it in:

```bash
cp .env.example .env
# Required: SESSION_SECRET (any 32+ random chars: `openssl rand -hex 32`)
# For live quotes + analytics: ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY (a free Alpaca
#   PAPER account provides market-data keys — no funding needed).
# For real emails: RESEND_API_KEY (without it, emails are logged to the worker console).
```

Without Alpaca keys the app still boots — the market/analytics routes are simply disabled.

### Path A — Docker (one command)

Brings up Postgres + Redis + web + worker. Postgres/Redis are internal to the compose network
(no host ports), so this does not collide with a local Postgres/Redis.

```bash
docker compose up --build        # (verified with the standalone binary: `docker-compose up --build`)
```

The web service runs migrations automatically on start. Open **http://localhost:3000**.
*(Verified: with local brew Postgres/Redis stopped, all four services boot from compose alone and
the end-to-end smoke passes against the containerized stack.)*

### Path B — brew-native (fast local loop)

```bash
brew install postgresql@16 redis
brew services start postgresql@16 && brew services start redis
psql -d postgres -c "CREATE ROLE mpw LOGIN PASSWORD 'mpw';" && createdb -O mpw mpw

npm install
npm run db:migrate
npm run dev:web       # http://localhost:3000
npm run dev:worker    # separate terminal — the scheduler + email queue
```

### Tests

```bash
npm test               # 50 hermetic unit tests — no DB/Redis needed
npm run test:integration   # 6 tests against a real Postgres + Redis
npm run check:alpaca   # live multi-symbol snapshot sanity check (needs Alpaca keys)
npm run prove:pipe     # one real quote -> alert crossing -> one email, through the real pipe
```

---

## Design notes

### The ledger is the source of truth

`transactions` (BUY/SELL/DIVIDEND/DEPOSIT/WITHDRAWAL/FEE) is authoritative. Positions, average
cost, cash balance, and P&L are folded from it on read. There is no stored share count. The one
subtle surface is the **signed cash balance** — a mis-signed line produces a plausible-but-wrong
terminal value and therefore a wrong XIRR, so the sign table is a single source of truth
(`cashEffect`) and the XIRR fixture test asserts the derived cash balance *separately* from the
rate, cross-checked by an independent arithmetic oracle.

### MWR (XIRR) vs TWR — what each measures, and why they diverge

- **Money-Weighted Return (MWR / XIRR)** — *implemented.* The internal rate of return of the
  investor's actual dated cashflows. It answers *"what return did **I** earn, given the timing and
  size of the money I put in and took out?"* — so it includes the investor's timing luck. Cashflows
  are **exact external boundary crossings only**: DEPOSIT (−), WITHDRAWAL (+), plus terminal value
  (holdings at live prices + derived cash). BUY/SELL/DIVIDEND/FEE are *internal* moves captured in
  the terminal value — counting a BUY as a contribution would corrupt XIRR. Solved with
  Newton–Raphson + a bisection fallback; validated against the Microsoft Excel XIRR reference
  (`0.373362535`).
- **Time-Weighted Return (TWR)** — *intentionally not implemented* (see limitations). It chains
  per-period returns and strips out cashflow timing, answering *"how did the **strategy** do,
  comparably to a benchmark?"* The two diverge whenever contribution timing matters: buy heavily
  right before a rally and your MWR beats the strategy's TWR; buy right before a drop and it lags.
  TWR needs a historical daily-value series, which this MVP deliberately does not carry.

**Underfunded-ledger reconciliation.** If you record buys but no deposit, reported cash goes
negative (the honest ledger fold), while MWR synthesizes the first buy's cost as the funding event
so the rate still resolves. The UI shows a one-line note so the two figures never read as
contradictory.

### Alert FSM + cross-process fire-once

```
ARMED ──(crossed, FRESH quote)──▶ TRIGGERED ──▶ COOLDOWN ──(cooldown elapsed
  ▲                                                          AND price re-crossed by hysteresis)
  └──────────────────── RECURRING re-arm ◀───────────────────┘        │
                          ONE_SHOT ─────────────────────────────▶ DISABLED
```

A crossing fires **once**. The guarantee is enforced by the database, not app-level locking: the
worker records a trigger with

```sql
INSERT INTO alert_events (..., dedupe_key) VALUES (...)
  ON CONFLICT (dedupe_key) DO NOTHING RETURNING id;
```

`dedupe_key = alertId:armEpoch`, so a retry of the same cycle produces the same key (idempotent),
while a genuine re-arm mints a new one. Under N concurrent workers the UNIQUE index elects exactly
one insert winner; only the winner enqueues the email. This is proven by an integration test that
runs **two poll cycles concurrently against real Postgres** and asserts one event + one email.
Email sending is a separate step keyed on `email_status` (skip if already SENT) plus a provider
idempotency key.

### Two staleness bounds — never fire on stale data

Quotes carry two independent freshness verdicts:

- **display staleness** (lenient) — a slightly-old quote is still shown, just flagged.
- **alert staleness** (strict, ~1 poll interval) — a quote older than this is **skipped** by the
  alert evaluator. A stale display self-corrects on the next refresh; a stale alert email is
  irreversible.

Live example: on Alpaca's free IEX feed, **BRK.A**'s last *trade* can be years old (IEX rarely
trades it), so `/quotes` serves it flagged `stale: true` and the alert evaluator refuses to fire
on it — visible as a **STALE** badge in the UI.

### The quote layer (a core deliverable, not an optimization)

Dedups the symbol universe across all users/alerts, batches the whole set into one Alpaca snapshot
call, caches with a short TTL (N users watching AAPL = 1 upstream call), rate-limits with a token
bucket, retries 429/5xx with jittered backoff, and is market-hours aware (no polling US equities at
3am). On a provider outage it degrades to the last-known quote, flagged — the alert run never
crashes and never fires on the stale value.

---

## Known limitations and what I'd do next

These are deliberate scope decisions — knowing what to skip matters as much as closing the gaps.

- **The real-email (Resend) path is implemented but unexercised.** No `RESEND_API_KEY` was
  configured, so the alert→email pipe was proven end-to-end only with the `LoggingSender` (the
  event transitions to `SENT`, the email is logged rather than delivered). The `ResendSender` and
  its `Idempotency-Key` handling are written but have **not** been run against the live Resend API;
  set `RESEND_API_KEY` and run `npm run prove:pipe` to exercise an actual send.
- **Email delivery is at-least-once, not exactly-once.** The Resend `Idempotency-Key` (keyed on
  our `dedupe_key`) dedupes duplicate **send requests** for 24h — it does **not** make *delivery*
  exactly-once. The residual double-send is a retry that lands **>24h** after a success whose
  response was lost (so we never marked it SENT and the idempotency window has expired). Closing it
  would mean persisting the provider message id transactionally with the send, or an outbound
  dedupe store with >24h retention.
- **Alpaca free is IEX-only (~2.5% of consolidated volume).** Quotes are real-time but from a
  single venue, so thin names (e.g. BRK.A) can carry a years-old last trade — served but flagged
  stale by design. A production build would use a consolidated (SIP) feed, or blend IEX quotes with
  a separate last-close source, behind the same `QuoteProvider` interface.
- **No dead-letter handling.** A poll or email job that exhausts BullMQ retries stays on the failed
  set; nothing drains or alerts on it. Next step: a DLQ with an operator view / re-drive, and a
  metric on failed-job depth.
- **No scheduler-overlap hardening beyond BullMQ defaults.** Overlapping poll cycles are *safe*
  (the outbox dedupes duplicate triggers), but nothing prevents a slow cycle from overlapping the
  next tick. Next step: a repeatable job with a concurrency-1 lock (or `jobId`-based singleton) so
  cycles can't stack under load.
- **Historical analytics are deliberately descoped.** TWR, annualized volatility, max drawdown,
  Sharpe, and beta were cut to keep the MVP tight — not because of a data gap. Alpaca's free
  (Basic) tier *does* serve historical daily bars via IEX (7+ years); the provider that paywalls
  historical candles is Finnhub (`/stock/candle` → 403 on free keys), which is a different vendor.
  These five metrics all consume the same daily-close series and all demonstrate the same skill, so
  I kept one metric family (XIRR, avg-cost unrealized P/L, allocation) and cut the whole history
  pipeline rather than half-build it. Re-adding them means restoring a `HistoryProvider` interface
  behind the existing provider abstraction, fed by a daily-value snapshot table.

---

## Repository map

```
src/
  domain/derive.ts        ledger fold: positions, avg cost, signed cash balance
  analytics/              xirr.ts (Newton+bisection), portfolio-analytics.ts, routes.ts
  alerts/                 fsm.ts (state machine), outbox.ts (idempotency), routes.ts
  market/                 provider.ts (interface), alpaca.ts, quote-service.ts (cache/dedup/
                          rate-limit/market-hours), redis-cache.ts, staleness.ts
  worker/                 poll-cycle.ts, alert-worker.ts (BullMQ), index.ts (worker entrypoint)
  auth/  db/  config/     sessions (argon2), Drizzle schema + migrations, env validation
public/index.html         the minimal SPA
test/                     unit tests; test/integration/ needs Postgres+Redis
PLAN.md  DECISIONS.md      architecture + the running decision log
```
