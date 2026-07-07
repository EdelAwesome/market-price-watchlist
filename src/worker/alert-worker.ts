import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { eq, ne } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { systemClock, type Clock } from '../market/clock.js';
import type { EvalQuote } from '../alerts/fsm.js';
import { recordTrigger, processEmailJob, type EmailSender } from '../alerts/outbox.js';
import { runPollCycle, type PollAlert, type PollSummary } from './poll-cycle.js';

/**
 * Wires the poll cycle and the outbox onto REAL BullMQ queues + workers. The email queue is where
 * BullMQ's retry + backoff live; the poll queue is driven by a repeatable (scheduled) job. Both
 * the production entrypoint and the integration tests build workers through here — the only things
 * injected are the quote source and the email sender, so tests need no Alpaca/Resend.
 */
export interface AlertWorkerDeps {
  connection: ConnectionOptions;
  getQuotes: (symbols: string[]) => Promise<Map<string, EvalQuote>>;
  sender: EmailSender;
  clock?: Clock;
  /** unique per test run to isolate queues; defaults to the shared names */
  queuePrefix?: string;
  /** email job retry policy (BullMQ) */
  emailAttempts?: number;
  emailBackoffMs?: number;
  pollConcurrency?: number;
}

export interface AlertWorkerHandles {
  pollQueue: Queue;
  emailQueue: Queue;
  pollWorker: Worker;
  emailWorker: Worker;
  /** Enqueue a single poll cycle immediately (tests trigger cycles explicitly). */
  triggerPollCycle: (id?: string) => Promise<void>;
  /** Register the repeatable scheduler (production). */
  scheduleEvery: (seconds: number) => Promise<void>;
  close: () => Promise<void>;
}

async function loadActiveAlerts(): Promise<PollAlert[]> {
  const rows = await db.select().from(schema.alerts).where(ne(schema.alerts.state, 'DISABLED'));
  return rows.map((a) => ({
    id: a.id,
    symbol: a.symbol,
    direction: a.direction,
    threshold: Number(a.threshold),
    state: a.state,
    rearmPolicy: a.rearmPolicy,
    cooldownSeconds: a.cooldownSeconds,
    hysteresisPct: Number(a.hysteresisPct),
    armedAt: a.armedAt,
    lastTriggeredAt: a.lastTriggeredAt,
  }));
}

export function startAlertWorkers(deps: AlertWorkerDeps): AlertWorkerHandles {
  const clock = deps.clock ?? systemClock;
  const prefix = deps.queuePrefix ? `${deps.queuePrefix}:` : '';
  const pollName = `${prefix}alert-poll`;
  const emailName = `${prefix}alert-email`;
  const connection = deps.connection;

  const pollQueue = new Queue(pollName, { connection });
  const emailQueue = new Queue(emailName, { connection });

  const enqueueEmail = async (eventId: string): Promise<void> => {
    // jobId = eventId dedupes at the QUEUE level too; the outbox status guard is the backstop.
    await emailQueue.add(
      'send',
      { eventId },
      {
        jobId: eventId,
        attempts: deps.emailAttempts ?? 5,
        backoff: { type: 'fixed', delay: deps.emailBackoffMs ?? 1000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  };

  const pollWorker = new Worker(
    pollName,
    async (): Promise<PollSummary> =>
      runPollCycle({
        clock,
        loadActiveAlerts,
        getQuotes: deps.getQuotes,
        persistAlert: async (id, fields) => {
          await db.update(schema.alerts).set(fields).where(eq(schema.alerts.id, id));
        },
        recordTrigger,
        enqueueEmail,
      }),
    { connection, concurrency: deps.pollConcurrency ?? 1 },
  );

  const emailWorker = new Worker(
    emailName,
    async (job) => processEmailJob(job.data.eventId as string, deps.sender),
    { connection, concurrency: 5 },
  );

  return {
    pollQueue,
    emailQueue,
    pollWorker,
    emailWorker,
    triggerPollCycle: async (id) => {
      await pollQueue.add('cycle', {}, id ? { jobId: id } : undefined);
    },
    scheduleEvery: async (seconds) => {
      await pollQueue.add(
        'cycle',
        {},
        { repeat: { every: seconds * 1000 }, removeOnComplete: true, removeOnFail: 100 },
      );
    },
    close: async () => {
      await pollWorker.close();
      await emailWorker.close();
      await pollQueue.close();
      await emailQueue.close();
    },
  };
}
