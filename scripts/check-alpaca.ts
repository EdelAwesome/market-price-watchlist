/**
 * Empirical de-risk for slice 2: prove the multi-symbol snapshot endpoint returns a 200 with
 * data for >= 2 symbols on the ACTUAL free key + IEX feed. This converts the "snapshot works on
 * free" claim from doc-inferred to empirically-true — slice 2's batch layer bets on it.
 *
 * Run: `npm run check:alpaca` (requires ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY in .env)
 */
import { env } from '../src/config/env.js';
import { AlpacaQuoteProvider } from '../src/market/alpaca.js';

const SYMBOLS = ['AAPL', 'MSFT', 'SPY'];

async function main() {
  if (!env.ALPACA_API_KEY_ID || !env.ALPACA_API_SECRET_KEY) {
    console.error('✗ ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY not set in .env');
    process.exit(2);
  }

  const provider = new AlpacaQuoteProvider({
    keyId: env.ALPACA_API_KEY_ID,
    secretKey: env.ALPACA_API_SECRET_KEY,
    dataUrl: env.ALPACA_DATA_URL,
    feed: env.ALPACA_FEED,
  });

  console.log(`→ multi-symbol snapshot: ${SYMBOLS.join(', ')} (feed=${env.ALPACA_FEED})`);
  const quotes = await provider.getQuotes(SYMBOLS);

  for (const s of SYMBOLS) {
    const q = quotes.get(s);
    console.log(
      q
        ? `   ${s}: ${q.price}  (prevClose=${q.prevClose ?? 'n/a'}, asOf=${q.asOf.toISOString()}, ${q.source})`
        : `   ${s}: <no data>`,
    );
  }

  if (quotes.size >= 2) {
    console.log(`✓ PASS — 200 OK with data for ${quotes.size}/${SYMBOLS.length} symbols`);
    process.exit(0);
  }
  console.error(`✗ FAIL — only ${quotes.size} symbol(s) returned data (need >= 2)`);
  process.exit(1);
}

main().catch((err) => {
  console.error('✗ FAIL —', err instanceof Error ? err.message : err);
  process.exit(1);
});
