import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  integer,
  boolean,
  pgEnum,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

// Money/quantities as numeric (never float). Drizzle returns numerics as strings, preserving
// precision — the domain layer parses them into Decimal.
const money = (name: string) => numeric(name, { precision: 20, scale: 8 });

export const txnType = pgEnum('txn_type', [
  'BUY',
  'SELL',
  'DIVIDEND',
  'DEPOSIT',
  'WITHDRAWAL',
  'FEE',
]);
export const alertType = pgEnum('alert_type', ['ABSOLUTE']); // one type in MVP; column future-proofs
export const alertDirection = pgEnum('alert_direction', ['ABOVE', 'BELOW']);
export const alertState = pgEnum('alert_state', ['ARMED', 'TRIGGERED', 'COOLDOWN', 'DISABLED']);
export const rearmPolicy = pgEnum('rearm_policy', ['ONE_SHOT', 'RECURRING']);
export const emailStatus = pgEnum('email_status', ['PENDING', 'SENT', 'FAILED']);

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (tbl) => [index('sessions_user_idx').on(tbl.userId)],
);

export const portfolios = pgTable('portfolios', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  baseCurrency: text('base_currency').notNull().default('USD'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const watchlists = pgTable('watchlists', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const watchlistItems = pgTable(
  'watchlist_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    watchlistId: uuid('watchlist_id')
      .notNull()
      .references(() => watchlists.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (tbl) => [uniqueIndex('watchlist_symbol_uq').on(tbl.watchlistId, tbl.symbol)],
);

export const instruments = pgTable('instruments', {
  symbol: text('symbol').primaryKey(),
  name: text('name'),
  assetClass: text('asset_class').notNull().default('us_equity'),
  exchange: text('exchange'),
  currency: text('currency').notNull().default('USD'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    type: txnType('type').notNull(),
    symbol: text('symbol'), // null for DEPOSIT/WITHDRAWAL
    quantity: money('quantity').notNull().default('0'),
    price: money('price').notNull().default('0'),
    fees: money('fees').notNull().default('0'),
    currency: text('currency').notNull().default('USD'),
    tradeTime: timestamp('trade_time', { withTimezone: true }).notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (tbl) => [index('transactions_portfolio_time_idx').on(tbl.portfolioId, tbl.tradeTime)],
);

export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    portfolioId: uuid('portfolio_id').references(() => portfolios.id, { onDelete: 'set null' }),
    symbol: text('symbol').notNull(),
    type: alertType('type').notNull().default('ABSOLUTE'),
    direction: alertDirection('direction').notNull(),
    threshold: money('threshold').notNull(),
    state: alertState('state').notNull().default('ARMED'),
    rearmPolicy: rearmPolicy('rearm_policy').notNull().default('ONE_SHOT'),
    cooldownSeconds: integer('cooldown_seconds').notNull().default(3600),
    hysteresisPct: numeric('hysteresis_pct', { precision: 8, scale: 4 }).notNull().default('0'),
    armedAt: timestamp('armed_at', { withTimezone: true }).notNull().defaultNow(),
    lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (tbl) => [index('alerts_symbol_state_idx').on(tbl.symbol, tbl.state)],
);

export const alertEvents = pgTable(
  'alert_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    alertId: uuid('alert_id')
      .notNull()
      .references(() => alerts.id, { onDelete: 'cascade' }),
    triggeredAt: timestamp('triggered_at', { withTimezone: true }).notNull().defaultNow(),
    triggerPrice: money('trigger_price').notNull(),
    // UNIQUE anti-duplicate anchor for both firing and email (`alertId:triggerEpoch`).
    dedupeKey: text('dedupe_key').notNull().unique(),
    emailStatus: emailStatus('email_status').notNull().default('PENDING'),
    emailProviderId: text('email_provider_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (tbl) => [index('alert_events_alert_idx').on(tbl.alertId)],
);

export const quoteCache = pgTable('quote_cache', {
  symbol: text('symbol').primaryKey(),
  price: money('price').notNull(),
  prevClose: money('prev_close'),
  asOf: timestamp('as_of', { withTimezone: true }).notNull(),
  source: text('source').notNull(),
  isStale: boolean('is_stale').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
