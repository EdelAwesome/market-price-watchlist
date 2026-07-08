import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { QuoteService } from './quote-service.js';

/**
 * /quotes goes through the cached/deduped QuoteService (not the raw provider), and surfaces
 * staleness + degrade flags so the UI can flag a last-known quote.
 */
export function marketRoutes(svc: QuoteService) {
  return async function (app: FastifyInstance) {
    app.get('/quotes', { preHandler: [app.requireAuth] }, async (req, reply) => {
      const { symbols } = z.object({ symbols: z.string().min(1) }).parse(req.query);
      const list = symbols
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      if (list.length === 0) return reply.code(400).send({ error: 'no symbols' });

      const quotes = await svc.getQuotes(list);
      return {
        quotes: Object.fromEntries(
          [...quotes.values()].map((q) => [
            q.symbol,
            {
              symbol: q.symbol,
              price: q.price,
              prevClose: q.prevClose,
              asOf: q.asOf.toISOString(),
              source: q.source,
              ageSeconds: Math.round(q.ageSeconds),
              stale: !q.okForDisplay, // UI flag
              degraded: q.degraded, // served last-known during an outage
            },
          ]),
        ),
      };
    });
  };
}
