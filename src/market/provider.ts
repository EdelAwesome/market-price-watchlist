/**
 * The provider seam. The rest of the app depends ONLY on this interface, never on Alpaca
 * directly, so the vendor is swappable (Finnhub/Twelve Data are documented alternates). Scope is
 * deliberately QUOTES ONLY — no historical bars anywhere in the MVP.
 */
export interface Quote {
  symbol: string;
  price: number; // latest trade price
  prevClose: number | null; // prior official close, when the provider supplies it
  asOf: Date; // provider timestamp for the quote
  source: string; // e.g. "alpaca:iex"
}

export interface QuoteProvider {
  readonly name: string;
  /** Fetch latest quotes for many symbols in as few calls as the provider allows. */
  getQuotes(symbols: string[]): Promise<Map<string, Quote>>;
}
