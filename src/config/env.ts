import 'dotenv/config';
import { z } from 'zod';

/** Fail fast at boot if config is missing/malformed. Secrets come from env only, never code. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be >= 16 chars'),

  DATABASE_URL: z.string().url(),

  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  REDIS_QUEUE_DB: z.coerce.number().int().min(0).default(0),
  REDIS_CACHE_DB: z.coerce.number().int().min(0).default(1),

  ALPACA_API_KEY_ID: z.string().min(1).optional(),
  ALPACA_API_SECRET_KEY: z.string().min(1).optional(),
  ALPACA_DATA_URL: z.string().url().default('https://data.alpaca.markets'),
  ALPACA_FEED: z.enum(['iex', 'sip']).default('iex'),

  QUOTE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  ALERT_STALENESS_SECONDS: z.coerce.number().int().positive().default(90),
  DISPLAY_STALENESS_SECONDS: z.coerce.number().int().positive().default(300),

  RESEND_API_KEY: z.string().optional(),
  ALERT_FROM_EMAIL: z.string().email().default('alerts@example.com'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
