import type { Clock } from '../market/clock.js';
import {
  evaluateAlert,
  applyOutcome,
  type AlertRuntime,
  type EvalQuote,
  type MutableAlertFields,
} from '../alerts/fsm.js';
import type { RecordResult } from '../alerts/outbox.js';

/** An active alert plus the symbol it watches (the FSM itself is symbol-agnostic). */
export interface PollAlert extends AlertRuntime {
  symbol: string;
}

export interface PollSummary {
  evaluated: number;
  symbolsFetched: number;
  fired: number;
  emailsEnqueued: number; // == number of insert WINNERS (losers enqueue nothing)
  skippedStale: number;
  noQuote: number;
  transitions: number;
}

export interface PollDeps {
  clock: Clock;
  loadActiveAlerts: () => Promise<PollAlert[]>;
  /** Fetch quotes for the deduped universe via the cached quote layer (or a mock in tests). */
  getQuotes: (symbols: string[]) => Promise<Map<string, EvalQuote>>;
  persistAlert: (id: string, fields: MutableAlertFields) => Promise<void>;
  recordTrigger: (input: {
    alertId: string;
    dedupeKey: string;
    triggerPrice: string;
    triggeredAt: Date;
  }) => Promise<RecordResult>;
  enqueueEmail: (eventId: string) => Promise<void>;
}

/**
 * One poll cycle:
 *   1. Load active alerts, dedup their symbols into one universe (N alerts on AAPL -> 1 fetch).
 *   2. Fetch fresh quotes through the cached quote layer.
 *   3. Evaluate each alert's FSM against its quote; persist any state transition.
 *   4. On FIRED: record the trigger via the outbox. Only the insert WINNER enqueues an email —
 *      a concurrent worker that lost the unique-key race enqueues nothing (no duplicate email).
 * A missing quote (provider down / no data) is skipped, never treated as a trigger.
 */
export async function runPollCycle(deps: PollDeps): Promise<PollSummary> {
  const now = deps.clock.now();
  const alerts = await deps.loadActiveAlerts();
  const universe = [...new Set(alerts.map((a) => a.symbol.toUpperCase()))];
  const quotes = await deps.getQuotes(universe);

  const summary: PollSummary = {
    evaluated: 0,
    symbolsFetched: universe.length,
    fired: 0,
    emailsEnqueued: 0,
    skippedStale: 0,
    noQuote: 0,
    transitions: 0,
  };

  for (const alert of alerts) {
    const quote = quotes.get(alert.symbol.toUpperCase());
    if (!quote) {
      summary.noQuote++;
      continue; // no data this cycle -> do not fire on nothing
    }

    summary.evaluated++;
    const outcome = evaluateAlert(alert, quote, now);

    if (outcome.type === 'SKIPPED_STALE') {
      summary.skippedStale++;
      continue; // no state drift, nothing to persist
    }
    if (outcome.type === 'NOOP') {
      continue;
    }

    // A real transition (FIRED/COOLDOWN/REARMED/DISABLED): persist the new fields.
    await deps.persistAlert(alert.id, applyOutcome(alert, outcome, now));
    summary.transitions++;

    if (outcome.type === 'FIRED') {
      summary.fired++;
      const result = await deps.recordTrigger({
        alertId: alert.id,
        dedupeKey: outcome.event.dedupeKey,
        triggerPrice: String(outcome.event.triggerPrice),
        triggeredAt: outcome.event.triggeredAt,
      });
      // Outbox gate: only the winner of the unique-key insert enqueues the email.
      if (result.created && result.eventId) {
        await deps.enqueueEmail(result.eventId);
        summary.emailsEnqueued++;
      }
    }
  }

  return summary;
}
