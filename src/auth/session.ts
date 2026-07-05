import { randomBytes, createHash } from 'node:crypto';
import { eq, and, gt } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

export const SESSION_COOKIE = 'mpw_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// The raw token lives only in the cookie; we store only its SHA-256 hash, so a DB leak can't be
// replayed as a session.
const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

export async function createSession(userId: string): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(schema.sessions).values({ userId, tokenHash: hashToken(raw), expiresAt });
  return raw;
}

export async function resolveSession(raw: string | undefined): Promise<{ userId: string } | null> {
  if (!raw) return null;
  const rows = await db
    .select({ userId: schema.sessions.userId })
    .from(schema.sessions)
    .where(
      and(eq(schema.sessions.tokenHash, hashToken(raw)), gt(schema.sessions.expiresAt, new Date())),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function destroySession(raw: string | undefined): Promise<void> {
  if (!raw) return;
  await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(raw)));
}
