import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

/** Confirms a portfolio belongs to the caller; returns it or null. */
async function ownedPortfolio(userId: string, portfolioId: string) {
  const [p] = await db
    .select()
    .from(schema.portfolios)
    .where(and(eq(schema.portfolios.id, portfolioId), eq(schema.portfolios.userId, userId)))
    .limit(1);
  return p ?? null;
}

export async function portfolioRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/portfolios', async (req) => {
    const rows = await db
      .select()
      .from(schema.portfolios)
      .where(eq(schema.portfolios.userId, req.userId!));
    return { portfolios: rows };
  });

  app.post('/portfolios', async (req, reply) => {
    const body = z
      .object({ name: z.string().min(1), baseCurrency: z.string().length(3).default('USD') })
      .parse(req.body);
    const [p] = await db
      .insert(schema.portfolios)
      .values({ userId: req.userId!, name: body.name, baseCurrency: body.baseCurrency })
      .returning();
    return reply.code(201).send({ portfolio: p });
  });

  // --- watchlists ---
  app.get('/watchlists', async (req) => {
    const lists = await db
      .select()
      .from(schema.watchlists)
      .where(eq(schema.watchlists.userId, req.userId!));
    return { watchlists: lists };
  });

  app.post('/watchlists', async (req, reply) => {
    const body = z.object({ name: z.string().min(1) }).parse(req.body);
    const [w] = await db
      .insert(schema.watchlists)
      .values({ userId: req.userId!, name: body.name })
      .returning();
    return reply.code(201).send({ watchlist: w });
  });

  app.post('/watchlists/:id/items', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ symbol: z.string().min(1).max(12) }).parse(req.body);

    const [owned] = await db
      .select({ id: schema.watchlists.id })
      .from(schema.watchlists)
      .where(and(eq(schema.watchlists.id, id), eq(schema.watchlists.userId, req.userId!)))
      .limit(1);
    if (!owned) return reply.code(404).send({ error: 'watchlist not found' });

    const [item] = await db
      .insert(schema.watchlistItems)
      .values({ watchlistId: id, symbol: body.symbol.toUpperCase() })
      .onConflictDoNothing()
      .returning();
    return reply.code(201).send({ item: item ?? null });
  });
}

export { ownedPortfolio };
