/**
 * Step-2 acceptance proof: ONE real alert crossing -> ONE email, through the REAL pipe
 * (live Alpaca quote -> cached quote layer -> FSM -> outbox -> BullMQ email queue -> sender).
 *
 * With RESEND_API_KEY set this delivers a real email; without it, the LoggingSender "delivers"
 * to the console (status still transitions to SENT). Run: `npm run prove:pipe`.
 */
import { eq } from 'drizzle-orm';
import { db, schema, closeDb } from '../src/db/client.js';
import { systemClock } from '../src/market/clock.js';
import { makeQuoteService, makeGetQuotes } from '../src/market/service-factory.js';
import { makeQueueConnectionOptions } from '../src/queue/connection.js';
import { startAlertWorkers } from '../src/worker/alert-worker.js';
import { makeEmailSender } from '../src/email/senders.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const svc = makeQuoteService();
  const getQuotes = makeGetQuotes(svc);

  // 1. Live price for AAPL.
  const q = (await svc.getQuotes(['AAPL'])).get('AAPL');
  if (!q) throw new Error('no AAPL quote');
  console.log(`live AAPL = ${q.price} (asOf ${q.asOf.toISOString()}, okForAlerts=${q.okForAlerts})`);
  if (!q.okForAlerts) throw new Error('AAPL quote is stale (market closed?) — cannot prove firing');

  // 2. Seed a user + an ARMED alert that the current price crosses (ABOVE price-10).
  const email = `pipe_${Date.now()}@example.com`;
  const [user] = await db.insert(schema.users).values({ email, passwordHash: 'x' }).returning();
  const threshold = (q.price - 10).toFixed(2);
  const [alert] = await db
    .insert(schema.alerts)
    .values({ userId: user!.id, symbol: 'AAPL', direction: 'ABOVE', threshold, rearmPolicy: 'ONE_SHOT' })
    .returning();
  console.log(`armed alert ${alert!.id}: AAPL ABOVE ${threshold} -> to ${email}`);

  // 3. Start the real workers and trigger one poll cycle.
  const workers = startAlertWorkers({
    connection: makeQueueConnectionOptions(),
    clock: systemClock,
    getQuotes,
    sender: makeEmailSender(),
    queuePrefix: 'prove',
  });
  workers.pollWorker.on('error', () => {});
  workers.emailWorker.on('error', () => {});

  await workers.triggerPollCycle();

  // 4. Wait for the outbox event to reach SENT.
  let status = '';
  for (let i = 0; i < 60; i++) {
    const [ev] = await db
      .select()
      .from(schema.alertEvents)
      .where(eq(schema.alertEvents.alertId, alert!.id));
    if (ev) {
      status = ev.emailStatus;
      if (status === 'SENT') {
        console.log(`event ${ev.id}: dedupeKey=${ev.dedupeKey} price=${ev.triggerPrice} status=${status} provider=${ev.emailProviderId}`);
        break;
      }
    }
    await delay(250);
  }

  await workers.close();
  await db.delete(schema.users).where(eq(schema.users.id, user!.id)); // cascade cleanup
  await closeDb();

  if (status === 'SENT') {
    console.log('\n✓ PIPE PROVEN — one real alert crossing -> one email delivered (status SENT)');
    process.exit(0);
  }
  console.error(`\n✗ pipe did not complete (last status: ${status || 'no event'})`);
  process.exit(1);
}

main().catch(async (err) => {
  console.error('✗', err instanceof Error ? err.message : err);
  await closeDb().catch(() => {});
  process.exit(1);
});
