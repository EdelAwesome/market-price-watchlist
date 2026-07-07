import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { authPlugin } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { portfolioRoutes } from './portfolios/routes.js';
import { transactionRoutes } from './transactions/routes.js';
import { alertRoutes } from './alerts/routes.js';
import { marketRoutes } from './market/routes.js';

export async function buildApp(opts: { withMarket?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: env.NODE_ENV !== 'test' });

  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(authPlugin);

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
  // Market routes require Alpaca keys; allow the app to boot without them (e.g. tests).
  if (opts.withMarket ?? Boolean(env.ALPACA_API_KEY_ID && env.ALPACA_API_SECRET_KEY)) {
    await app.register(marketRoutes);
  }

  return app;
}
