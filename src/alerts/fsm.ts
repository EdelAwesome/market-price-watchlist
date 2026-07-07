/**
 * Absolute-price alert STATE MACHINE. This is the backend's core correctness claim: an alert is
 * stateful and idempotent, not `if price > x: send()`.
 *
 *   ARMED --(condition true, FRESH quote)--> TRIGGERED --(next cycle)--> COOLDOWN
 *   COOLDOWN --(cooldown elapsed AND price re-crossed by hysteresis)--> ARMED   (RECURRING)
 *   TRIGGERED/COOLDOWN --(one-shot spent)--> DISABLED                            (ONE_SHOT)
 *   DISABLED: not evaluated.
 *
 * Guarantees encoded here (verified by tests):
 *  - Fires EXACTLY ONCE per arm: firing moves ARMED->TRIGGERED, so the same crossing can't fire
 *    again; the dedupe key is derived from the ARM EPOCH so a worker RETRY of the same cycle is
 *    idempotent (stable key), while a genuine re-arm mints a new key.
 *  - Cooldown + hysteresis stop a price oscillating around the threshold from spamming.
 *  - NEVER fires (or re-arms) on stale data — a quote not okForAlerts is skipped entirely.
 *
 * Pure + clock-injected: no DB, no I/O. The worker (slice 5) persists what applyOutcome returns.
 */

export type AlertStateName = 'ARMED' | 'TRIGGERED' | 'COOLDOWN' | 'DISABLED';
export type Direction = 'ABOVE' | 'BELOW';
export type RearmPolicy = 'ONE_SHOT' | 'RECURRING';

export interface AlertRuntime {
  id: string;
  direction: Direction;
  threshold: number;
  state: AlertStateName;
  rearmPolicy: RearmPolicy;
  cooldownSeconds: number;
  hysteresisPct: number; // re-arm band as a percent of threshold
  armedAt: Date; // arm epoch — anchors the idempotent dedupe key
  lastTriggeredAt: Date | null;
}

export interface EvalQuote {
  price: number;
  asOf: Date;
  okForAlerts: boolean; // strict-staleness gate from the quote layer
}

export interface TriggerEvent {
  dedupeKey: string;
  triggerPrice: number;
  triggeredAt: Date;
}

export type AlertOutcome =
  | { type: 'SKIPPED_STALE' }
  | { type: 'NOOP'; nextState: AlertStateName }
  | { type: 'FIRED'; nextState: 'TRIGGERED'; event: TriggerEvent }
  | { type: 'COOLDOWN'; nextState: 'COOLDOWN' }
  | { type: 'REARMED'; nextState: 'ARMED' }
  | { type: 'DISABLED'; nextState: 'DISABLED' };

export function conditionMet(direction: Direction, price: number, threshold: number): boolean {
  return direction === 'ABOVE' ? price >= threshold : price <= threshold;
}

/** Price has retreated to the non-triggering side of the threshold by the hysteresis band. */
export function rearmPriceMet(a: AlertRuntime, price: number): boolean {
  const band = (a.threshold * a.hysteresisPct) / 100;
  return a.direction === 'ABOVE' ? price <= a.threshold - band : price >= a.threshold + band;
}

export function evaluateAlert(a: AlertRuntime, q: EvalQuote, now: Date): AlertOutcome {
  if (a.state === 'DISABLED') return { type: 'NOOP', nextState: 'DISABLED' };

  // Hard stale gate: never fire, re-arm, or otherwise act on a quote too old to trust. A stale
  // alert email is irreversible; skipping is safe and self-corrects on the next fresh quote.
  if (!q.okForAlerts) return { type: 'SKIPPED_STALE' };

  if (a.state === 'ARMED') {
    if (conditionMet(a.direction, q.price, a.threshold)) {
      return {
        type: 'FIRED',
        nextState: 'TRIGGERED',
        event: {
          // Arm-epoch key: stable across retries of THIS cycle, unique per arm.
          dedupeKey: `${a.id}:${a.armedAt.getTime()}`,
          triggerPrice: q.price,
          triggeredAt: now,
        },
      };
    }
    return { type: 'NOOP', nextState: 'ARMED' };
  }

  // TRIGGERED or COOLDOWN: decide whether to re-arm, disable, or keep cooling.
  if (a.rearmPolicy === 'ONE_SHOT') {
    // A one-shot alert is spent the moment it fired; it never re-arms.
    return { type: 'DISABLED', nextState: 'DISABLED' };
  }

  const cooldownElapsed = a.lastTriggeredAt
    ? (now.getTime() - a.lastTriggeredAt.getTime()) / 1000 >= a.cooldownSeconds
    : true;

  if (cooldownElapsed && rearmPriceMet(a, q.price)) {
    return { type: 'REARMED', nextState: 'ARMED' };
  }
  return { type: 'COOLDOWN', nextState: 'COOLDOWN' };
}

export interface MutableAlertFields {
  state: AlertStateName;
  armedAt: Date;
  lastTriggeredAt: Date | null;
}

/** Maps an outcome to the alert's next persisted fields. Pure; the worker writes the result. */
export function applyOutcome(a: AlertRuntime, outcome: AlertOutcome, now: Date): MutableAlertFields {
  const base: MutableAlertFields = {
    state: a.state,
    armedAt: a.armedAt,
    lastTriggeredAt: a.lastTriggeredAt,
  };
  switch (outcome.type) {
    case 'SKIPPED_STALE':
    case 'NOOP':
      return base;
    case 'FIRED':
      return { ...base, state: 'TRIGGERED', lastTriggeredAt: outcome.event.triggeredAt };
    case 'COOLDOWN':
      return { ...base, state: 'COOLDOWN' };
    case 'REARMED':
      return { ...base, state: 'ARMED', armedAt: now }; // new arm epoch -> new future dedupe key
    case 'DISABLED':
      return { ...base, state: 'DISABLED' };
  }
}
