import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { makeQuoteProvider } from './factory.js';

/**
 * Slice-1 RAW quote fetch: goes straight to the provider (no cache/dedup yet — that is slice 2).
 * Supports multiple symbols so slice 2's batch layer builds on a proven multi-symbol call.
 */
export async function marketRoutes(app: FastifyInstance) {
  const provider = makeQuoteProvider();

  app.get('/quotes', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { symbols } = z
      .object({ symbols: z.string().min(1) })
      .parse(req.query);
    const list = symbols
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (list.length === 0) return reply.code(400).send({ error: 'no symbols' });

    const quotes = await provider.getQuotes(list);
    return {
      source: provider.name,
      quotes: Object.fromEntries(
        [...quotes.values()].map((q) => [
          q.symbol,
          { price: q.price, prevClose: q.prevClose, asOf: q.asOf.toISOString(), source: q.source },
        ]),
      ),
    };
  });
}
