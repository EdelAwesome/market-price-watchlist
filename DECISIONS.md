# DECISIONS log

One line of rationale per non-obvious choice. Append-only; supersede rather than delete.

## Scope (reduced MVP)
- **Ledger-only project:** every number derives from the transaction ledger + a current quote.
  **No historical-bar dependency.** This removes the single most complex external dependency
  while still demonstrating: correct money-weighted return, a real background worker, idempotent
  notifications, and a clean derived-data model.
- **Removed entirely:** HistoryProvider + Alpaca historical bars; TWR, annualized volatility,
  max drawdown, Sharpe, beta vs SPY, benchmark comparison, HHI/concentration; FIFO realized P/L
  and all lot tracking; every alert type except absolute price (dropped %-move, trailing-stop,
  allocation-drift).
- **Kept:** two-process architecture (Fastify web + separate BullMQ worker); Postgres = source
  of truth; Redis = queue + quote cache; ledger-first model; three analytics (XIRR, avg-cost
  unrealized P/L, allocation by weight); absolute-price alerts with the full FSM; the
  dedup/cache/rate-limit quote layer; session-cookie auth.

## Market data provider
- **Alpaca Market Data API (Basic/free) behind a single `QuoteProvider` interface — QUOTES
  ONLY.** No HistoryProvider. Swappable if a better quote source appears.
- **IEX-feed caveat:** Alpaca's free feed is **IEX-only (~2.5% of consolidated US volume)**.
  Acceptable for liquid names; the tradeoff vs. the consolidated SIP tape is understood and
  explainable, and quote staleness is surfaced in the UI. SIP feed would require a paid sub.
- Multi-symbol **snapshot** endpoint used with `feed=iex` (free); the SIP feed — not the
  endpoint itself — is what's gated.
- Rejected Finnhub (1 symbol/call, no batch; candles now premium) and Twelve Data
  (EOD/delayed quotes, 8/min) as primary; both remain drop-in `QuoteProvider` alternates.
  Alpha Vantage (25/day) and IEX Cloud (dead since 2024) excluded per spec.

## Analytics
- **Three metrics only:** XIRR, average-cost unrealized P/L, allocation by weight.
- **XIRR cashflows = EXACT external boundary crossings only:** DEPOSIT (−), WITHDRAWAL incl.
  withdrawn dividends (+), plus terminal value = holdings mkt value + derived cash balance.
  **BUY/SELL/DIVIDEND/FEE are internal, NOT cashflows** — a BUY is cash→shares, not external
  cash; counting it would corrupt XIRR.
- **Funding fallback:** if no DEPOSIT row, default the initial contribution to the first BUY's
  total cost dated on that BUY. If funding still can't resolve (no deposit, no buy), show MWR
  as **"unavailable — add a deposit,"** never a guess. (Multi-buy unfunded portfolios should
  add DEPOSIT rows for accuracy.)
- **XIRR solver:** Newton–Raphson + bisection fallback (Newton diverges on irregular sign
  flips); degenerate inputs (single/all-same-sign flow) → unavailable, not a bogus root.
- **Cost basis: average-cost** (not FIFO). SELLs remove shares at the current average; the
  average is unchanged by a sell. Unrealized P/L = (quote − avg_cost) × qty.
- **Allocation:** position weight = position mkt value / Σ position mkt values. No HHI/sector.
- **Reported `cash` is the honest ledger fold**, even when negative (a BUY with no recorded
  DEPOSIT reports −cost, an "underfunded ledger" signal). Synthetic funding is a device INSIDE
  the MWR math only; it never rewrites the reported cash balance.
- **Missing quote degrades one holding, not the whole call**: that holding's market fields are
  null; cash + other holdings still compute.

## Queue / scheduler
- **BullMQ + Redis**, worker in a **separate process** from web. Chosen over node-cron because
  the alert system needs idempotent job processing, retries with backoff+jitter, repeatable
  scheduling, and job-level dedupe (jobId = dedupe key). Redis also serves the quote cache.

## Redis eviction isolation
- Queue on Redis **logical DB 0** with **no eviction**; cache on **logical DB 1** where any
  `maxmemory`/LRU policy applies. Cache pressure can therefore **never evict BullMQ queue
  keys** (which would silently drop jobs).

## Quote layer
- Dedup symbol universe across all users before fetching; **60s Redis TTL** so N watchers of a
  symbol = 1 fetch; durable `quote_cache` for the degrade path; token-bucket rate limit sized
  to Alpaca 200/min; exponential backoff + jitter on 429/5xx.
- **Market-hours aware:** poll US equities only during NYSE regular hours (holiday calendar).

## Quote layer internals (slice 2)
- **Provider-agnostic core built + tested against a MockQuoteProvider** with an injected clock;
  the Alpaca snapshot parser is intentionally NOT finalized until an empirical `check:alpaca`
  run on a real key confirms the response shape (avoids baking in an assumed schema).
- **In-flight coalescing:** concurrent requests for the same symbol share one upstream promise
  (dedup across the universe AND across concurrent callers → 1 call per symbol).
- **Cache keeps last-known even past TTL** (no auto-evict in the store) so the degrade path can
  serve it flagged `degraded` + not-alert-safe. TTL freshness uses `storedAt`; staleness uses the
  quote's provider `asOf` — distinct clocks on purpose.
- **Backoff:** full-jitter exponential (`delay ∈ [0, min(maxMs, base·2^n)]`); retry only on
  429/5xx, fail fast on 4xx. Sleep + RNG injected for deterministic tests.
- **Market-hours:** static NYSE holiday set (2025–2026, maintained as the calendar rolls); ET via
  `Intl` (DST-correct, no tz dep); early-close half-days treated as full days for MVP.

## Staleness (two bounds, not one)
- **DISPLAY staleness (lenient):** serve last-known quote, flag it in the UI; self-corrects on
  next refresh.
- **ALERT staleness (strict, ~1 poll interval):** if the quote backing a potential trigger is
  older than this bound, **SKIP** evaluation — never email on stale data. A stale display is
  cheap; a stale alert email is irreversible.

## Alerts
- One type: **absolute price ABOVE/BELOW threshold.** Full FSM
  `ARMED → TRIGGERED → COOLDOWN → (re-ARM | DISABLED)`. Fire-once via UNIQUE `dedupe_key` on
  `alert_events`. Cooldown + hysteresis stop oscillation spam; `rearm_policy` = ONE_SHOT |
  RECURRING. `type` column kept fixed at ABSOLUTE for future extension.
- **Email idempotency:** outbox keyed by `alert_event.id`; Resend called with idempotency key;
  worker checks `email_status` before sending so a retry can't double-send. Failed sends retry
  via BullMQ; the trigger is never lost (event row already persisted).

## Auth
- **Opaque session cookie** (httpOnly, SameSite=Lax; argon2id password hash) over JWT —
  simpler server-side revocation for a stateful web app.

## Money representation
- Postgres `numeric`, never float, for all prices/quantities/money.
```
