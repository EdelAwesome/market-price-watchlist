import { env } from '../config/env.js';
import type { QuoteProvider } from './provider.js';
import { AlpacaQuoteProvider } from './alpaca.js';

/** Builds the configured QuoteProvider. Swap here to change vendors app-wide. */
export function makeQuoteProvider(): QuoteProvider {
  if (!env.ALPACA_API_KEY_ID || !env.ALPACA_API_SECRET_KEY) {
    throw new Error('ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are required for quotes');
  }
  return new AlpacaQuoteProvider({
    keyId: env.ALPACA_API_KEY_ID,
    secretKey: env.ALPACA_API_SECRET_KEY,
    dataUrl: env.ALPACA_DATA_URL,
    feed: env.ALPACA_FEED,
  });
}
