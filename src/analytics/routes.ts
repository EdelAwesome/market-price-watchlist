import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { ownedPortfolio } from '../portfolios/routes.js';
import { derivePositions, type LedgerTxn } from '../domain/derive.js';
import { computePortfolioAnalytics } from './portfolio-analytics.js';
import type { QuoteService } from '../market/quote-service.js';

/** GET /portfolios/:id/analytics — XIRR + avg-cost unrealized P/L + allocation with LIVE quotes. */
export function analyticsRoutes(svc: QuoteService) {
  return async function (app: FastifyInstance) {
    app.get(
      '/portfolios/:id/analytics',
      { preHandler: [app.requireAuth] },
      async (req, reply) => {
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

        // Fetch quotes only for the symbols we actually hold (deduped by the quote layer).
        const symbols = [...derivePositions(ledger).keys()];
        const prices = new Map<string, number>();
        if (symbols.length > 0) {
          const quotes = await svc.getQuotes(symbols);
          for (const [sym, q] of quotes) prices.set(sym, q.price);
        }

        const analytics = computePortfolioAnalytics(ledger, prices, new Date());
        return { analytics };
      },
    );
  };
}
