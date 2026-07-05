import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { SESSION_COOKIE, resolveSession } from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Populates req.userId from the session cookie (if present) on every request, and exposes a
 * `requireAuth` preHandler that 401s when there is no valid session.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  app.addHook('onRequest', async (req) => {
    const raw = req.cookies?.[SESSION_COOKIE];
    const session = await resolveSession(raw);
    if (session) req.userId = session.userId;
  });

  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.userId) {
      await reply.code(401).send({ error: 'authentication required' });
    }
  });
});
