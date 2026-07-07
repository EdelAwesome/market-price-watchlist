import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

const createAlert = z.object({
  symbol: z.string().min(1).max(12),
  direction: z.enum(['ABOVE', 'BELOW']),
  threshold: z.coerce.number().positive(),
  rearmPolicy: z.enum(['ONE_SHOT', 'RECURRING']).default('ONE_SHOT'),
  cooldownSeconds: z.coerce.number().int().nonnegative().default(3600),
  hysteresisPct: z.coerce.number().min(0).max(100).default(0),
  portfolioId: z.string().uuid().optional(),
});

export async function alertRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.post('/alerts', async (req, reply) => {
    const b = createAlert.parse(req.body);
    const [alert] = await db
      .insert(schema.alerts)
      .values({
        userId: req.userId!,
        portfolioId: b.portfolioId ?? null,
        symbol: b.symbol.toUpperCase(),
        direction: b.direction,
        threshold: String(b.threshold),
        rearmPolicy: b.rearmPolicy,
        cooldownSeconds: b.cooldownSeconds,
        hysteresisPct: String(b.hysteresisPct),
      })
      .returning();
    return reply.code(201).send({ alert });
  });

  app.get('/alerts', async (req) => {
    const rows = await db
      .select()
      .from(schema.alerts)
      .where(eq(schema.alerts.userId, req.userId!));
    return { alerts: rows };
  });

  app.delete('/alerts/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const deleted = await db
      .delete(schema.alerts)
      .where(and(eq(schema.alerts.id, id), eq(schema.alerts.userId, req.userId!)))
      .returning({ id: schema.alerts.id });
    if (deleted.length === 0) return reply.code(404).send({ error: 'alert not found' });
    return { ok: true };
  });

  // Manual state controls (pausing / re-arming). The scheduled worker drives all other transitions.
  app.post('/alerts/:id/disable', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return setState(req.userId!, id, 'DISABLED', reply);
  });

  app.post('/alerts/:id/arm', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return setState(req.userId!, id, 'ARMED', reply, /* resetArmedAt */ true);
  });
}

async function setState(
  userId: string,
  id: string,
  state: 'DISABLED' | 'ARMED',
  reply: FastifyReply,
  resetArmedAt = false,
) {
  const [updated] = await db
    .update(schema.alerts)
    .set(resetArmedAt ? { state, armedAt: new Date() } : { state })
    .where(and(eq(schema.alerts.id, id), eq(schema.alerts.userId, userId)))
    .returning();
  if (!updated) return reply.code(404).send({ error: 'alert not found' });
  return { alert: updated };
}
