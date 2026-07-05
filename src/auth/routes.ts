import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { env } from '../config/env.js';
import { SESSION_COOKIE, createSession, destroySession } from './session.js';

const credentials = z.object({
  email: z.string().email().transform((e) => e.toLowerCase()),
  password: z.string().min(8, 'password must be at least 8 characters'),
});

const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.NODE_ENV === 'production',
  path: '/',
  maxAge: 60 * 60 * 24 * 7,
};

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/signup', async (req, reply) => {
    const { email, password } = credentials.parse(req.body);

    const existing = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    if (existing.length > 0) {
      return reply.code(409).send({ error: 'email already registered' });
    }

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const [user] = await db
      .insert(schema.users)
      .values({ email, passwordHash })
      .returning({ id: schema.users.id, email: schema.users.email });

    const token = await createSession(user!.id);
    return reply.setCookie(SESSION_COOKIE, token, cookieOpts).code(201).send({ user });
  });

  app.post('/auth/login', async (req, reply) => {
    const { email, password } = credentials.parse(req.body);

    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    // Verify even when the user is missing to keep timing roughly uniform, then fail uniformly.
    const ok = user
      ? await argon2.verify(user.passwordHash, password).catch(() => false)
      : await argon2
          .hash('placeholder', { type: argon2.argon2id })
          .then(() => false)
          .catch(() => false);

    if (!user || !ok) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }

    const token = await createSession(user.id);
    return reply
      .setCookie(SESSION_COOKIE, token, cookieOpts)
      .send({ user: { id: user.id, email: user.email } });
  });

  app.post('/auth/logout', async (req, reply) => {
    await destroySession(req.cookies?.[SESSION_COOKIE]);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true });
  });

  app.get('/auth/me', { preHandler: [app.requireAuth] }, async (req) => {
    const [user] = await db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, req.userId!))
      .limit(1);
    return { user };
  });
}
