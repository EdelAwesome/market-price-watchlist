import { describe, it, expect, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, schema, closeDb } from '../../src/db/client.js';
import {
  recordTrigger,
  processEmailJob,
  type EmailSender,
  type AlertEmail,
} from '../../src/alerts/outbox.js';
import { FakeClock } from '../../src/market/clock.js';
import { runPollCycle, type PollAlert, type PollDeps } from '../../src/worker/poll-cycle.js';
import type { EvalQuote } from '../../src/alerts/fsm.js';

// Track seeded users so we can cascade-delete everything after the run.
const createdUsers: string[] = [];

async function seedAlert(over: Partial<typeof schema.alerts.$inferInsert> = {}) {
  const email = `outbox_${Date.now()}_${Math.floor(Math.random() * 1e9)}@example.com`;
  const [u] = await db.insert(schema.users).values({ email, passwordHash: 'x' }).returning();
  createdUsers.push(u!.id);
  const [a] = await db
    .insert(schema.alerts)
    .values({ userId: u!.id, symbol: 'AAPL', direction: 'ABOVE', threshold: '100', ...over })
    .returning();
  return { userId: u!.id, alertId: a!.id, email, armedAt: a!.armedAt };
}

class FakeSender implements EmailSender {
  readonly sends: { email: AlertEmail; key: string }[] = [];
  constructor(private readonly mode: 'ok' | 'fail' = 'ok') {}
  async send(email: AlertEmail, idempotencyKey: string): Promise<{ id: string }> {
    if (this.mode === 'fail') throw new Error('provider down');
    this.sends.push({ email, key: idempotencyKey });
    return { id: `re_${this.sends.length}` };
  }
}

afterAll(async () => {
  if (createdUsers.length) {
    await db.delete(schema.users).where(inArray(schema.users.id, createdUsers)); // cascades
  }
  await closeDb();
});

describe('outbox — CENTERPIECE: concurrent-insert-loser (the real idempotency guarantee)', () => {
  it('two concurrent inserts of the same dedupe_key => exactly ONE winner, ONE row', async () => {
    const { alertId } = await seedAlert();
    const input = {
      alertId,
      dedupeKey: `${alertId}:race`,
      triggerPrice: '101',
      triggeredAt: new Date(),
    };

    // Fire both concurrently: they race at the DB, resolved by the UNIQUE index, not app locking.
    const [r1, r2] = await Promise.all([recordTrigger(input), recordTrigger(input)]);

    const winners = [r1, r2].filter((r) => r.created);
    const losers = [r1, r2].filter((r) => !r.created);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]!.eventId).toBeTruthy();
    expect(losers[0]!.eventId).toBeNull(); // the loser has nothing to enqueue

    const rows = await db
      .select()
      .from(schema.alertEvents)
      .where(eq(schema.alertEvents.dedupeKey, input.dedupeKey));
    expect(rows).toHaveLength(1); // exactly one event persisted, no duplicate
  });

  it('scales: 10 concurrent inserts => still exactly ONE winner', async () => {
    const { alertId } = await seedAlert();
    const input = {
      alertId,
      dedupeKey: `${alertId}:stampede`,
      triggerPrice: '101',
      triggeredAt: new Date(),
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => recordTrigger(input)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const rows = await db
      .select()
      .from(schema.alertEvents)
      .where(eq(schema.alertEvents.dedupeKey, input.dedupeKey));
    expect(rows).toHaveLength(1);
  });
});

describe('outbox — email send is idempotent on retry', () => {
  it('sends once, skips on retry, records provider id + recipient', async () => {
    const { alertId, email } = await seedAlert();
    const { eventId } = await recordTrigger({
      alertId,
      dedupeKey: `${alertId}:mail`,
      triggerPrice: '101',
      triggeredAt: new Date(),
    });
    const sender = new FakeSender('ok');

    expect(await processEmailJob(eventId!, sender)).toBe('sent');
    expect(sender.sends).toHaveLength(1);
    expect(sender.sends[0]!.email.to).toBe(email);
    expect(sender.sends[0]!.key).toBe(eventId); // idempotency key = event id

    // Retry the job (as BullMQ would): must NOT send again.
    expect(await processEmailJob(eventId!, sender)).toBe('skipped');
    expect(sender.sends).toHaveLength(1);

    const [ev] = await db
      .select()
      .from(schema.alertEvents)
      .where(eq(schema.alertEvents.id, eventId!));
    expect(ev!.emailStatus).toBe('SENT');
    expect(ev!.emailProviderId).toBeTruthy();
  });

  it('marks FAILED (trigger not lost) when the provider throws', async () => {
    const { alertId } = await seedAlert();
    const { eventId } = await recordTrigger({
      alertId,
      dedupeKey: `${alertId}:failmail`,
      triggerPrice: '101',
      triggeredAt: new Date(),
    });
    await expect(processEmailJob(eventId!, new FakeSender('fail'))).rejects.toThrow(/provider down/);

    const [ev] = await db
      .select()
      .from(schema.alertEvents)
      .where(eq(schema.alertEvents.id, eventId!));
    expect(ev!.emailStatus).toBe('FAILED'); // persisted -> BullMQ retry can pick it up
  });
});

describe('outbox — two concurrent WORKERS running the poll cycle', () => {
  it('a fired alert yields exactly one event and one enqueued email across both workers', async () => {
    const { alertId } = await seedAlert({ threshold: '100', direction: 'ABOVE' });
    const now = new Date('2025-06-10T14:00:00Z');
    const enqueued: string[] = [];

    const makeDeps = (): PollDeps => ({
      clock: new FakeClock(now),
      loadActiveAlerts: async (): Promise<PollAlert[]> => {
        const [a] = await db
          .select()
          .from(schema.alerts)
          .where(eq(schema.alerts.id, alertId));
        return [
          {
            id: a!.id,
            symbol: a!.symbol,
            direction: a!.direction,
            threshold: Number(a!.threshold),
            state: a!.state,
            rearmPolicy: a!.rearmPolicy,
            cooldownSeconds: a!.cooldownSeconds,
            hysteresisPct: Number(a!.hysteresisPct),
            armedAt: a!.armedAt,
            lastTriggeredAt: a!.lastTriggeredAt,
          },
        ];
      },
      getQuotes: async (): Promise<Map<string, EvalQuote>> =>
        new Map([['AAPL', { price: 101, asOf: now, okForAlerts: true }]]),
      persistAlert: async (id, fields) => {
        await db.update(schema.alerts).set(fields).where(eq(schema.alerts.id, id));
      },
      recordTrigger, // real outbox insert
      enqueueEmail: async (eventId) => {
        enqueued.push(eventId);
      },
    });

    // Two workers evaluate the same ARMED alert in the same cycle -> same arm-epoch dedupe key.
    await Promise.all([runPollCycle(makeDeps()), runPollCycle(makeDeps())]);

    const events = await db
      .select()
      .from(schema.alertEvents)
      .where(eq(schema.alertEvents.alertId, alertId));
    expect(events).toHaveLength(1); // one trigger event despite two workers
    expect(enqueued).toHaveLength(1); // one email enqueued (only the insert winner)
  });
});
