import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { ownedPortfolio } from '../portfolios/routes.js';
import { derivePortfolio, type LedgerTxn } from '../domain/derive.js';

const createTxn = z
  .object({
    type: z.enum(['BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL', 'FEE']),
    symbol: z.string().min(1).max(12).optional(),
    quantity: z.coerce.number().nonnegative().default(1),
    price: z.coerce.number().nonnegative().default(0),
    fees: z.coerce.number().nonnegative().default(0),
    currency: z.string().length(3).default('USD'),
    tradeTime: z.coerce.date(),
    note: z.string().max(500).optional(),
  })
  .refine((v) => !(v.type === 'BUY' || v.type === 'SELL' || v.type === 'DIVIDEND') || !!v.symbol, {
    message: 'symbol is required for BUY/SELL/DIVIDEND',
    path: ['symbol'],
  });

export async function transactionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.post('/portfolios/:id/transactions', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await ownedPortfolio(req.userId!, id))) {
      return reply.code(404).send({ error: 'portfolio not found' });
    }
    const body = createTxn.parse(req.body);
    const [txn] = await db
      .insert(schema.transactions)
      .values({
        portfolioId: id,
        type: body.type,
        symbol: body.symbol ? body.symbol.toUpperCase() : null,
        quantity: String(body.quantity),
        price: String(body.price),
        fees: String(body.fees),
        currency: body.currency,
        tradeTime: body.tradeTime,
        note: body.note ?? null,
      })
      .returning();
    return reply.code(201).send({ transaction: txn });
  });

  app.get('/portfolios/:id/transactions', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await ownedPortfolio(req.userId!, id))) {
      return reply.code(404).send({ error: 'portfolio not found' });
    }
    const rows = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.portfolioId, id));
    return { transactions: rows };
  });

  // Derived positions + cash from the ledger — proof the model is derive-only, no stored shares.
  // (Market value / P&L / XIRR come once the quote + analytics slices land.)
  app.get('/portfolios/:id/positions', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await ownedPortfolio(req.userId!, id))) {
      return reply.code(404).send({ error: 'portfolio not found' });
    }
    const rows = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.portfolioId, id));

    const ledger: LedgerTxn[] = rows.map((r) => ({
      type: r.type,
      symbol: r.symbol,
      quantity: r.quantity,
      price: r.price,
      fees: r.fees,
      tradeTime: r.tradeTime,
    }));
    const { cash, positions } = derivePortfolio(ledger);

    return {
      cash: cash.toFixed(2),
      positions: positions.map((p) => ({
        symbol: p.symbol,
        quantity: p.quantity.toString(),
        avgCost: p.avgCost.toFixed(4),
        costBasis: p.costBasis.toFixed(2),
      })),
    };
  });
}
