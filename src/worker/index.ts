import { env } from '../config/env.js';
import { makeQueueConnectionOptions } from '../queue/connection.js';
import { startAlertWorkers } from './alert-worker.js';
import { makeEmailSender } from '../email/senders.js';
import { makeQuoteService, makeGetQuotes } from '../market/service-factory.js';
import type { EvalQuote } from '../alerts/fsm.js';

/**
 * The worker process — SEPARATE from the web server. Runs the repeatable poll scheduler and the
 * email queue. Boots even without Alpaca/Resend keys (logs a warning, fetches nothing / logs
 * emails) so it can run under docker-compose immediately; real fetch+send switch on with the keys.
 */
const POLL_EVERY_SECONDS = 60;

const connection = makeQueueConnectionOptions();

const getQuotes = (() => {
  if (env.ALPACA_API_KEY_ID && env.ALPACA_API_SECRET_KEY) {
    return makeGetQuotes(makeQuoteService());
  }
  console.warn('[worker] ALPACA keys unset — poll cycles run but fetch no quotes');
  return async (): Promise<Map<string, EvalQuote>> => new Map();
})();

const workers = startAlertWorkers({
  connection,
  getQuotes,
  sender: makeEmailSender(),
});

await workers.scheduleEvery(POLL_EVERY_SECONDS);
console.log(`[worker] up — polling every ${POLL_EVERY_SECONDS}s`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.log(`[worker] ${sig} — shutting down`);
    await workers.close();
    process.exit(0);
  });
}
