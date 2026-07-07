import { describe, it, expect } from 'vitest';
import {
  evaluateAlert,
  applyOutcome,
  type AlertRuntime,
  type EvalQuote,
  type AlertOutcome,
} from '../src/alerts/fsm.js';

const T0 = new Date('2025-06-10T14:00:00Z');
const at = (secs: number) => new Date(T0.getTime() + secs * 1000);
const quote = (price: number, fresh = true, asOf = T0): EvalQuote => ({
  price,
  asOf,
  okForAlerts: fresh,
});

function baseAlert(over: Partial<AlertRuntime> = {}): AlertRuntime {
  return {
    id: 'alert-1',
    direction: 'ABOVE',
    threshold: 100,
    state: 'ARMED',
    rearmPolicy: 'ONE_SHOT',
    cooldownSeconds: 3600,
    hysteresisPct: 0,
    armedAt: T0,
    lastTriggeredAt: null,
    ...over,
  };
}

// One evaluation cycle: evaluate, then fold the mutation back in (as the worker would persist it).
function step(a: AlertRuntime, q: EvalQuote, now: Date): { outcome: AlertOutcome; next: AlertRuntime } {
  const outcome = evaluateAlert(a, q, now);
  return { outcome, next: { ...a, ...applyOutcome(a, outcome, now) } };
}

describe('alert FSM — fires exactly once', () => {
  it('does not re-fire while the price stays across the threshold', () => {
    let a = baseAlert({ rearmPolicy: 'RECURRING' });
    let fires = 0;
    for (let s = 0; s <= 600; s += 60) {
      const { outcome, next } = step(a, quote(101), at(s));
      if (outcome.type === 'FIRED') fires++;
      a = next;
    }
    expect(fires).toBe(1); // one crossing -> one fire, not one-per-poll
  });

  it('fires immediately if the price is already across at arm time', () => {
    const { outcome } = step(baseAlert(), quote(105), T0);
    expect(outcome.type).toBe('FIRED');
  });

  it('supports BELOW alerts', () => {
    const { outcome } = step(baseAlert({ direction: 'BELOW', threshold: 50 }), quote(49), T0);
    expect(outcome.type).toBe('FIRED');
  });
});

describe('alert FSM — idempotent dedupe key (worker retry safe)', () => {
  it('produces the SAME dedupe key when the same armed cycle is re-evaluated', () => {
    const a = baseAlert();
    const first = evaluateAlert(a, quote(101), at(5));
    const retry = evaluateAlert(a, quote(101), at(9)); // retry at a different wall-clock time
    expect(first.type).toBe('FIRED');
    expect(retry.type).toBe('FIRED');
    if (first.type === 'FIRED' && retry.type === 'FIRED') {
      expect(first.event.dedupeKey).toBe(retry.event.dedupeKey); // stable -> DB unique dedupes it
    }
  });

  it('mints a NEW dedupe key after a genuine re-arm', () => {
    let a = baseAlert({ rearmPolicy: 'RECURRING', cooldownSeconds: 60, hysteresisPct: 0 });
    const fire1 = step(a, quote(101), at(0));
    const key1 = fire1.outcome.type === 'FIRED' ? fire1.outcome.event.dedupeKey : '';
    a = fire1.next;
    a = step(a, quote(101), at(30)).next; // COOLDOWN
    a = step(a, quote(95), at(120)).next; // cooldown elapsed + re-crossed -> REARMED (armedAt bumped)
    expect(a.state).toBe('ARMED');
    const fire2 = step(a, quote(101), at(130));
    const key2 = fire2.outcome.type === 'FIRED' ? fire2.outcome.event.dedupeKey : '';
    expect(fire2.outcome.type).toBe('FIRED');
    expect(key2).not.toBe(key1);
  });
});

describe('alert FSM — respects cooldown', () => {
  it('will not re-fire during cooldown even as the price oscillates', () => {
    let a = baseAlert({ rearmPolicy: 'RECURRING', cooldownSeconds: 3600, hysteresisPct: 0 });
    let fires = 0;
    const cycles: Array<[number, number]> = [
      [0, 101], // FIRE
      [60, 101], // cooldown -> no fire
      [1800, 95], // dipped, but cooldown not elapsed -> no re-arm
      [1801, 101], // back up, still cooling -> no fire
      [3700, 95], // cooldown elapsed AND re-crossed -> REARM
      [3760, 101], // FIRE again
    ];
    let sawRearm = false;
    for (const [s, price] of cycles) {
      const { outcome, next } = step(a, quote(price), at(s));
      if (outcome.type === 'FIRED') fires++;
      if (outcome.type === 'REARMED') sawRearm = true;
      a = next;
    }
    expect(fires).toBe(2);
    expect(sawRearm).toBe(true);
  });
});

describe('alert FSM — hysteresis blocks premature re-arm', () => {
  it('requires the price to retreat past the band, not just below the threshold', () => {
    let a = baseAlert({ rearmPolicy: 'RECURRING', cooldownSeconds: 0, hysteresisPct: 5 });
    a = step(a, quote(101), at(0)).next; // FIRE -> TRIGGERED
    // threshold 100, band = 5 -> must fall to <= 95 to re-arm. 99 is below threshold but inside band.
    const hovering = step(a, quote(99), at(10));
    expect(hovering.outcome.type).toBe('COOLDOWN'); // NOT re-armed despite cooldown elapsed
    a = hovering.next;
    const cleared = step(a, quote(95), at(20));
    expect(cleared.outcome.type).toBe('REARMED');
  });
});

describe('alert FSM — never acts on stale data', () => {
  it('skips a crossed threshold when the quote is not okForAlerts', () => {
    const { outcome, next } = step(baseAlert(), quote(101, /* fresh */ false), T0);
    expect(outcome.type).toBe('SKIPPED_STALE');
    expect(next.state).toBe('ARMED'); // unchanged — no fire, no state drift
  });

  it('fires once a FRESH quote confirms the crossing', () => {
    let a = baseAlert();
    a = step(a, quote(101, false), at(0)).next; // stale -> skipped
    const { outcome } = step(a, quote(101, true), at(60)); // fresh -> fires
    expect(outcome.type).toBe('FIRED');
  });
});

describe('alert FSM — one-shot lifecycle', () => {
  it('disables after firing and never fires again', () => {
    let a = baseAlert({ rearmPolicy: 'ONE_SHOT' });
    let fires = 0;
    const seq = [
      [0, 101], // FIRE -> TRIGGERED
      [60, 101], // -> DISABLED (one-shot spent)
      [120, 101], // stays DISABLED
      [3700, 101], // still DISABLED, long after any cooldown
    ] as const;
    for (const [s, price] of seq) {
      const { outcome, next } = step(a, quote(price), at(s));
      if (outcome.type === 'FIRED') fires++;
      a = next;
    }
    expect(fires).toBe(1);
    expect(a.state).toBe('DISABLED');
  });
});
