import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { env } from '../config/env.js';

/** Applies generated SQL migrations from ./drizzle. Run: `npm run db:migrate`. */
async function main() {
  const sql = postgres(env.DATABASE_URL, { max: 1 });
  const dbm = drizzle(sql);
  await migrate(dbm, { migrationsFolder: './drizzle' });
  await sql.end();
  console.log('migrations applied');
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
