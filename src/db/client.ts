import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import * as schema from './schema.js';

// Single shared pool for the web process. The worker creates its own in its entrypoint.
const queryClient = postgres(env.DATABASE_URL, { max: 10 });

export const db = drizzle(queryClient, { schema });
export { schema };
export type DB = typeof db;

/** Close the pool so short-lived processes (scripts, integration tests) can exit cleanly. */
export async function closeDb(): Promise<void> {
  await queryClient.end({ timeout: 5 });
}
