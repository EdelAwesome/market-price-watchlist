import { eq } from 'drizzle-orm';
import { db as defaultDb, schema } from '../db/client.js';
import type { DB } from '../db/client.js';

/**
 * The alert OUTBOX — two independent idempotency guarantees, each enforced by the database:
 *
 *  1. Event creation (this file's `recordTrigger`): the UNIQUE `dedupe_key` + INSERT ... ON
 *     CONFLICT DO NOTHING means a trigger records EXACTLY ONE event even when multiple workers
 *     evaluate the same alert in the same cycle. The insert WINNER (created=true) owns the email;
 *     every loser gets created=false and must not enqueue anything. This is the concurrency
 *     guarantee — a race at the DB, resolved by the unique index, not by app-level locking.
 *
 *  2. Email send (`processEmailJob`): the `email_status` guard skips an already-SENT event on a
 *     sequential retry; the provider idempotency key (= event id) prevents duplicate DELIVERY in
 *     the concurrent/crash-after-send window. Together: a BullMQ retry never double-sends.
 */

export interface TriggerInput {
  alertId: string;
  dedupeKey: string;
  triggerPrice: string; // numeric-as-string
  triggeredAt: Date;
}

export interface RecordResult {
  created: boolean; // true => we won the insert and own the email for this trigger
  eventId: string | null;
}

export async function recordTrigger(
  input: TriggerInput,
  database: DB = defaultDb,
): Promise<RecordResult> {
  const rows = await database
    .insert(schema.alertEvents)
    .values({
      alertId: input.alertId,
      dedupeKey: input.dedupeKey,
      triggerPrice: input.triggerPrice,
      triggeredAt: input.triggeredAt,
      emailStatus: 'PENDING',
    })
    .onConflictDoNothing({ target: schema.alertEvents.dedupeKey })
    .returning({ id: schema.alertEvents.id });

  const row = rows[0];
  return { created: Boolean(row), eventId: row?.id ?? null };
}

// --- Email send step ---

export interface AlertEmail {
  to: string;
  symbol: string;
  direction: string;
  threshold: string;
  price: string;
  triggeredAt: Date;
}

export interface EmailSender {
  /** `idempotencyKey` (= event id) lets the provider dedupe delivery across retries/crashes. */
  send(email: AlertEmail, idempotencyKey: string): Promise<{ id: string }>;
}

export type EmailOutcome = 'sent' | 'skipped' | 'failed';

export async function processEmailJob(
  eventId: string,
  sender: EmailSender,
  database: DB = defaultDb,
): Promise<EmailOutcome> {
  const [event] = await database
    .select()
    .from(schema.alertEvents)
    .where(eq(schema.alertEvents.id, eventId))
    .limit(1);
  if (!event) throw new Error(`alert_event ${eventId} not found`);
  if (event.emailStatus === 'SENT') return 'skipped'; // idempotent on retry

  const [alert] = await database
    .select()
    .from(schema.alerts)
    .where(eq(schema.alerts.id, event.alertId))
    .limit(1);
  if (!alert) throw new Error(`alert ${event.alertId} not found`);
  const [user] = await database
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, alert.userId))
    .limit(1);
  if (!user) throw new Error(`user ${alert.userId} not found`);

  try {
    const res = await sender.send(
      {
        to: user.email,
        symbol: alert.symbol,
        direction: alert.direction,
        threshold: alert.threshold,
        price: event.triggerPrice,
        triggeredAt: event.triggeredAt,
      },
      eventId, // idempotency key
    );
    await database
      .update(schema.alertEvents)
      .set({ emailStatus: 'SENT', emailProviderId: res.id })
      .where(eq(schema.alertEvents.id, eventId));
    return 'sent';
  } catch (err) {
    // Don't lose the trigger: the row persists as FAILED and BullMQ retries the job.
    await database
      .update(schema.alertEvents)
      .set({ emailStatus: 'FAILED' })
      .where(eq(schema.alertEvents.id, eventId));
    throw err;
  }
}
