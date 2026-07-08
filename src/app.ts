import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { authPlugin } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { portfolioRoutes } from './portfolios/routes.js';
import { transactionRoutes } from './transactions/routes.js';
import { alertRoutes } from './alerts/routes.js';
import { marketRoutes } from './market/routes.js';
import { analyticsRoutes } from './analytics/routes.js';
import { makeQuoteService } from './market/service-factory.js';

export async function buildApp(opts: { withMarket?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: env.NODE_ENV !== 'test' });

  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(authPlugin);

  // Serve the minimal single-page UI (public/index.html) at the root.
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  await app.register(fastifyStatic, { root: publicDir });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'validation_error', details: err.flatten() });
    }
    app.log.error(err);
    return reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'internal error' });
  });

  app.get('/health', async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(portfolioRoutes);
  await app.register(transactionRoutes);
  await app.register(alertRoutes);
  // Market + analytics routes need Alpaca keys (live quotes); the app still boots without them.
  if (opts.withMarket ?? Boolean(env.ALPACA_API_KEY_ID && env.ALPACA_API_SECRET_KEY)) {
    const quoteService = makeQuoteService();
    await app.register(marketRoutes(quoteService));
    await app.register(analyticsRoutes(quoteService));
  }

  return app;
}
