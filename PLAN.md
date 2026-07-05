# Market Price Watchlist — PLAN (reduced MVP scope)

A markets watchlist + stateful price-alert web app. The backend is the point. **Every number
comes from the transaction ledger + a current quote** — no historical-bar dependency at all.
This is deliberately scoped to a coherent, complete, impressive core:

- correct **money-weighted return (XIRR)** on exact external cashflows,
- a real **background worker** doing dedup/cache/rate-limit,
- **idempotent notifications** via an alert **state machine** with a fire-once guarantee,
- a clean **derived-data model** (positions and P/L are computed, never stored).

**No application code until this is acked.**

---

## 1. Architecture

Two **separate processes** plus infra, wired by `docker-compose` (one command to run):

```
                         ┌──────────────────────────────────────┐
                         │            docker-compose             │
                         │                                       │
   browser ──HTTP──▶  ┌──┴─────────┐        ┌──────────────┐     │
   (React/Vite)       │  web       │        │   worker     │     │
                      │  Fastify   │        │  BullMQ      │     │
                      │  REST API  │        │  + scheduler │     │
                      └──┬──────┬──┘        └───┬──────┬───┘     │
                         │      │               │      │         │
                         │      └──── Redis ────┘      │         │
                         │      (queue db0 + cache db1)│         │
                         │                             │         │
                         └────────── Postgres ─────────┘         │
                         │       (source of truth)               │
                         └──────────────┬────────────────────────┘
                                        │
                                Alpaca Market Data API
                               (QuoteProvider — QUOTES ONLY)
                                        │
                                   Resend (email)
```

- **web (Fastify + TS):** auth, CRUD for portfolios/watchlists/transactions/alerts, analytics
  read endpoints. Serves quotes **through the cache** — never calls the provider on the hot
  path. Does **not** run the scheduler.
- **worker (separate Node process):** BullMQ worker + BullMQ **repeatable job** as the
  scheduler. Runs the poll cycle (dedup → batch fetch → cache → evaluate alerts → enqueue
  emails) and the email-send jobs.
- **Redis:** BullMQ backend **and** the quote cache, on **separate logical DBs** so cache
  eviction can never drop queue keys (see DECISIONS).
- **Postgres:** durable source of truth. The **transaction ledger** is authoritative;
  positions, cash balance, and P/L are **derived**, never stored as a `shares` number.

### Build order (slices — each independently runnable + tested)
1. **Repo init** (`.gitignore`, `.env.example`) + auth + portfolio/watchlist + **transaction
   ledger** + a raw Alpaca quote fetch. **Empirical de-risk (this slice):** make a real
   **multi-symbol** snapshot call with `feed=iex` on the actual free key and confirm a **200
   with data for ≥2 symbols** — this converts the snapshot-on-free claim from doc-inferred to
   empirically-true, since slice 2's batch layer bets entirely on it.
2. **Cached / deduped / batched** quote layer (Alpaca snapshot endpoint, IEX feed) +
   market-hours gating.
3. **Analytics**: XIRR + average-cost unrealized P/L + allocation. **Hand-checked XIRR
   fixture test is MANDATORY.**
4. **Alert model + FSM + evaluation.** Tests with **mocked clock + mocked quotes** proving:
   fires exactly once, respects cooldown, skips on stale data. **MANDATORY.**
5. **Worker + scheduler + email delivery + outbox idempotency.**
6. **Frontend** (thin): portfolios, live quotes, XIRR + unrealized P/L + allocation, alert
   CRUD, alert status. Do not gold-plate.
Then: **README** with setup + design notes.

---

## 2. Data model

Postgres. `snake_case`, `id` = uuid, timestamps `timestamptz` (UTC). Money as `numeric(20,8)`
(never float). Symbols normalized uppercase.

```
users ──1:N── portfolios ──1:N── transactions   (BUY/SELL/DIVIDEND/DEPOSIT/WITHDRAWAL/FEE)
  │               │
  │               └──1:N── alerts ──1:N── alert_events   (audit + email idempotency anchor)
  │
  ├──1:N── watchlists ──1:N── watchlist_items
  └──1:N── sessions

instruments (symbol PK, metadata for the deduped universe)
quote_cache (symbol PK)  — durable last-known quote (Redis holds the hot TTL copy)
```

**users** — `id`, `email` (unique, citext), `password_hash` (argon2id), `created_at`.

**sessions** — `id`, `user_id` fk, `token_hash`, `expires_at`, `created_at`. Opaque session cookie.

**portfolios** — `id`, `user_id` fk, `name`, `base_currency` (default `USD`), `created_at`.

**watchlists** — `id`, `user_id` fk, `name`, `created_at`.
**watchlist_items** — `id`, `watchlist_id` fk, `symbol`, `created_at`. Unique `(watchlist_id, symbol)`.

**instruments** — `symbol` PK, `name`, `asset_class` (`us_equity`), `exchange`, `currency`.
Metadata backing the **deduped symbol universe**. (No `sector` — that needed a data source we
no longer call.)

**transactions** (the ledger — the heart of the model):
`id`, `portfolio_id` fk, `symbol` (nullable for DEPOSIT/WITHDRAWAL), `type`
(`BUY` | `SELL` | `DIVIDEND` | `DEPOSIT` | `WITHDRAWAL` | `FEE`), `quantity`, `price`, `fees`,
`currency`, `trade_time`, `note`, `created_at`.
- **No stored share count / no lots.** Everything below is folded from this table on read:
  - **Position** per symbol: `qty = Σ BUY.qty − Σ SELL.qty`.
  - **Average cost/share** (running average): BUYs add to the cost pool + share count; SELLs
    remove shares **at the current average** (average unchanged by a sell).
  - **Cash balance:** `+DEPOSIT −(BUY cost+fees) +(SELL proceeds−fees) +DIVIDEND −WITHDRAWAL −FEE`.

**alerts** (absolute-price only; the state machine, see §4):
`id`, `user_id` fk, `portfolio_id` (nullable), `symbol`, `type` (`ABSOLUTE`, fixed — column
kept for future extension), `direction` (`ABOVE` | `BELOW`), `threshold` numeric, `state`
(`ARMED` | `TRIGGERED` | `COOLDOWN` | `DISABLED`), `rearm_policy` (`ONE_SHOT` | `RECURRING`),
`cooldown_seconds`, `hysteresis_pct`, `armed_at`, `last_triggered_at`, `created_at`.

**alert_events** (audit + idempotency):
`id`, `alert_id` fk, `triggered_at`, `trigger_price`, `dedupe_key` **UNIQUE**, `email_status`
(`PENDING` | `SENT` | `FAILED`), `email_provider_id`, `created_at`. The UNIQUE `dedupe_key` is
the anti-duplicate anchor for both firing and email.

**quote_cache** — `symbol` PK, `price`, `prev_close`, `as_of`, `source`, `updated_at`.
Durable last-known quote for the degrade path (Redis holds the short-TTL hot copy).

---

## 3. Analytics — exactly three, all from ledger + current quote

### 3a. Money-Weighted Return — **XIRR**
> *"What return did the investor actually earn, given the timing and size of the cash they put
> in and took out?"* This is the number that **needs the ledger** — a single price series can't
> produce it, because it depends on *when* real cash crossed the account boundary.

**Cashflows are EXACT external boundary crossings only:**
- `DEPOSIT` → negative CF (investor puts money in), dated `trade_time`.
- `WITHDRAWAL` (incl. any withdrawn dividends) → positive CF, dated `trade_time`.
- **Terminal value** (dated today, positive) = `Σ (position qty × current quote) + cash balance`.
- **`BUY`/`SELL`/`DIVIDEND`/`FEE` are NOT external cashflows** — a BUY is an internal move
  (cash → shares), captured in terminal value. Counting a BUY as a contribution **corrupts
  XIRR**, so we never do it.

**The risk lives in the derived cash balance, not the definition.** Terminal value is only
correct if every ledger type moves cash with the right sign. This is the "plausible-but-wrong"
surface — a sign flip here plus a compensating error elsewhere can pass a rate-only test. The
one true table (any deviation is a bug):

| type | effect on derived cash | why |
|---|---|---|
| `DEPOSIT` | **+** | investor adds cash |
| `WITHDRAWAL` | **−** | investor removes cash |
| `BUY` | **−** (cost + fees) | cash → shares |
| `SELL` | **+** (proceeds − fees) | shares → cash |
| `DIVIDEND` | **+** | income lands as cash |
| `FEE` | **−** | cost leaves cash |

`terminal_value = Σ(position qty × current quote) + derived_cash`. Because a mis-signed line
looks plausible, the **XIRR fixture test asserts the derived cash balance at the terminal date
as its own expectation, separate from the XIRR rate** (see §7).

**Funding resolution:**
1. If any `DEPOSIT` exists → use the exact deposit/withdrawal set.
2. Else → default the initial contribution to the **first BUY's total cost, dated that BUY's
   `trade_time`** (single synthetic funding event). Other BUYs stay internal.
3. If funding still can't be resolved (no deposit and no buy) → report MWR as
   **"unavailable — add a deposit"**, never a guessed number.

**Solver:** Newton–Raphson on `NPV(r)=Σ CFᵢ/(1+r)^(daysᵢ/365)=0`, with a **bisection
fallback** (Newton can diverge on irregular sign patterns). Guard degenerate inputs
(single flow, all-same-sign) → unavailable rather than a bogus root.

### 3b. Average-cost **unrealized P/L**
- `avg_cost = running-average cost/share of the open position` (SELLs don't move it).
- `unrealized_pl = (current_quote − avg_cost) × qty_held`; also as a %.
- Price-only by construction; dividend cash is reflected in the cash balance and in XIRR.

### 3c. **Allocation by weight**
- Per position: `weight = position_market_value / Σ position_market_values`.
- That's it — no HHI, no concentration index, no sector split (all removed with the history
  dependency).

*(Removed from scope: TWR, annualized volatility, max drawdown, Sharpe, beta, benchmark
comparison, HHI, FIFO/realized P/L — every metric that needed a daily-close series.)*

Every metric gets a **unit test**; the **known-answer XIRR fixture is mandatory**.

---

## 4. Alert state machine (absolute price only)

Alerts are **stateful and idempotent**, not `if price > x: send()`. One type: **price crosses
`ABOVE`/`BELOW` a fixed `threshold`.** A crossing fires **once**.

```
                 threshold crossed (FRESH quote)
   ┌────────┐   ─────────────────────────────▶   ┌───────────┐
   │ ARMED  │                                     │ TRIGGERED │
   └────────┘                                     └───────────┘
      ▲   ▲                                              │
      │   │  re-arm: price back across threshold by      │ enter cooldown
      │   │  hysteresis_pct AND cooldown elapsed         ▼
      │   │                                       ┌───────────┐
      │   └────────────────────────────────────  │ COOLDOWN  │
      │        (RECURRING)                        └───────────┘
      │
      └── (ONE_SHOT) TRIGGERED → DISABLED (never re-arms)

   DISABLED: user-paused or one-shot spent. Not evaluated.
```

| State | On fresh quote | Emits email? |
|---|---|---|
| ARMED | condition true → **TRIGGERED**; write `alert_event` (UNIQUE `dedupe_key`); enqueue email | once, on transition |
| TRIGGERED | move to COOLDOWN, start `cooldown_seconds` | no |
| COOLDOWN | if cooldown elapsed **and** price re-crossed back by `hysteresis_pct`: RECURRING→ARMED, ONE_SHOT→DISABLED | no |
| DISABLED | ignored | no |

**Guarantees**
- **Fire-once:** the ARMED→TRIGGERED transition writes exactly one `alert_event` with a UNIQUE
  `dedupe_key` (`alert_id : trigger_epoch`). A retried poll cannot create a second event.
- **Cooldown + hysteresis:** a price oscillating around the threshold can't spam — re-arm
  needs both `cooldown_seconds` elapsed **and** the price back across by `hysteresis_pct`.
  `rearm_policy` = `ONE_SHOT` | `RECURRING`.
- **Never fire on stale data:** evaluation uses the **strict alert-staleness** bound (§5); a
  quote older than that is skipped, not triggered.
- **Email idempotency (outbox):** the email job is keyed by `alert_event.id`; the worker
  checks `email_status` and calls Resend with an **idempotency key** = event id. A worker
  retry after a crash re-runs the job but **cannot** double-send. A failed send marks `FAILED`
  and retries via BullMQ backoff — the trigger is never lost (event row already persisted).

---

## 5. Quote layer (core deliverable)

- **Dedup:** the poll cycle computes the **distinct** symbol set across all active alerts +
  watchlist items + open positions → N users watching AAPL = **1** fetch.
- **Batch:** Alpaca multi-symbol **snapshot** endpoint (`feed=iex`) fetches the whole deduped
  set in a few calls.
- **Cache:** Redis short-TTL hot quotes (**60s TTL**); durable `quote_cache` last-known for the
  degrade path. Read endpoints hit cache, not the provider.
- **Rate-limit + backoff:** token bucket sized to Alpaca's 200/min; retry with **exponential
  backoff + jitter** on 429/5xx; on exhaustion serve **last-known** flagged stale.
- **Market-hours aware:** US-equity poll only during NYSE regular hours (holiday calendar);
  outside hours serve last close and don't burn quota.

### Two staleness bounds (not one)
- **DISPLAY staleness (lenient):** serve last-known quote and **flag it in the UI**. A stale
  display self-corrects on the next refresh — low stakes.
- **ALERT staleness (strict, ~1 poll interval):** in the evaluation cycle, if the quote backing
  a potential trigger is older than this bound, **SKIP** the evaluation. A stale alert email
  is **irreversible**, so we never email on stale data. Both bounds are documented + configurable.

---

## 6. Committed defaults (say the word to flip any)
Average-cost basis · session-cookie auth (argon2id) · BullMQ + Redis · market-hours gating ·
60s quote TTL · Alpaca-only behind a single `QuoteProvider` (quotes only) · Sharpe/rf and all
history-based metrics **removed** from scope.

**Alpaca IEX caveat (logged in DECISIONS):** the free feed is **IEX-only (~2.5% of consolidated
volume)** — fine for liquid names; the tradeoff vs. the consolidated SIP tape is understood and
explainable, and staleness is surfaced.

---

## 7. Deliverables checklist
- [x] PLAN.md (this) — architecture, data model, XIRR, alert FSM, scope boundaries.
- [ ] DECISIONS.md — running log (rewritten to this scope).
- [ ] `.env.example` committed, `.env` gitignored, no secrets in code.
- [ ] Slices 1–6; **XIRR fixture test** (asserts **derived cash balance at the terminal date
      as a separate expectation** from the XIRR rate — catches a cash-sign error hidden by a
      compensating error) + **alert-FSM tests** (fires once / cooldown / stale-skip) mandatory.
- [ ] docker-compose: postgres + redis + web + worker (one command).
- [ ] README: setup, API-key step, running the worker, design notes (ledger authoritative;
      what XIRR measures & why it needs the ledger; alert FSM + fire-once; IEX-feed caveat).
```
