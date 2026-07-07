import { describe, it, expect } from 'vitest';
import { FakeClock } from '../src/market/clock.js';
import { runPollCycle, type PollAlert, type PollDeps } from '../src/worker/poll-cycle.js';
import type { EvalQuote } from '../src/alerts/fsm.js';
import type { RecordResult } from '../src/alerts/outbox.js';

const NOW = new Date('2025-06-10T14:00:00Z');

function alert(over: Partial<PollAlert> = {}): PollAlert {
  return {
    id: 'a1',
    symbol: 'AAPL',
    direction: 'ABOVE',
    threshold: 100,
    state: 'ARMED',
    rearmPolicy: 'ONE_SHOT',
    cooldownSeconds: 3600,
    hysteresisPct: 0,
    armedAt: NOW,
    lastTriggeredAt: null,
    ...over,
  };
}

const fresh = (price: number): EvalQuote => ({ price, asOf: NOW, okForAlerts: true });

interface Harness extends PollDeps {
  enqueued: string[];
  persisted: string[];
  fetchedWith: string[][];
}

function harness(
  alerts: PollAlert[],
  quotes: Map<string, EvalQuote>,
  recordTrigger: PollDeps['recordTrigger'] = async () => ({ created: true, eventId: 'e1' }),
): Harness {
  const enqueued: string[] = [];
  const persisted: string[] = [];
  const fetchedWith: string[][] = [];
  return {
    clock: new FakeClock(NOW),
    loadActiveAlerts: async () => alerts,
    getQuotes: async (symbols) => {
      fetchedWith.push(symbols);
      return quotes;
    },
    persistAlert: async (id) => {
      persisted.push(id);
    },
    recordTrigger,
    enqueueEmail: async (eventId) => {
      enqueued.push(eventId);
    },
    enqueued,
    persisted,
    fetchedWith,
  };
}

describe('runPollCycle', () => {
  it('dedups the symbol universe before fetching', async () => {
    const h = harness(
      [alert({ id: 'a1', symbol: 'AAPL' }), alert({ id: 'a2', symbol: 'aapl' }), alert({ id: 'a3', symbol: 'MSFT' })],
      new Map([
        ['AAPL', fresh(50)],
        ['MSFT', fresh(50)],
      ]),
    );
    const s = await runPollCycle(h);
    expect(h.fetchedWith[0]!.sort()).toEqual(['AAPL', 'MSFT']); // AAPL not fetched twice
    expect(s.symbolsFetched).toBe(2);
  });

  it('fires a crossed alert, persists the transition, enqueues one email', async () => {
    const h = harness([alert()], new Map([['AAPL', fresh(101)]]));
    const s = await runPollCycle(h);
    expect(s.fired).toBe(1);
    expect(s.emailsEnqueued).toBe(1);
    expect(h.enqueued).toEqual(['e1']);
    expect(h.persisted).toEqual(['a1']);
  });

  it('OUTBOX GATE: a fired alert whose trigger insert LOST the race enqueues no email', async () => {
    // Simulate a concurrent worker having already recorded this trigger: recordTrigger reports
    // created=false (the unique-key insert was a no-op for us).
    const loser: PollDeps['recordTrigger'] = async (): Promise<RecordResult> => ({
      created: false,
      eventId: null,
    });
    const h = harness([alert()], new Map([['AAPL', fresh(101)]]), loser);
    const s = await runPollCycle(h);
    expect(s.fired).toBe(1); // we did fire (state transitioned)
    expect(s.emailsEnqueued).toBe(0); // ...but we are NOT the one who emails
    expect(h.enqueued).toEqual([]);
  });

  it('skips a stale quote (never fires) and does not persist state drift', async () => {
    const staleQuote: EvalQuote = { price: 101, asOf: NOW, okForAlerts: false };
    const h = harness([alert()], new Map([['AAPL', staleQuote]]));
    const s = await runPollCycle(h);
    expect(s.skippedStale).toBe(1);
    expect(s.fired).toBe(0);
    expect(h.persisted).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });

  it('counts alerts with no quote as noQuote and does not fire them', async () => {
    const h = harness([alert({ symbol: 'ZZZZ' })], new Map()); // provider returned nothing
    const s = await runPollCycle(h);
    expect(s.noQuote).toBe(1);
    expect(s.fired).toBe(0);
  });
});
