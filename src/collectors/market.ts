import { config } from '../config.js';

export interface CryptoQuote {
  id: string;
  usd: number;
  idr: number;
  change24h: number;
}

export interface StockQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  currency: 'USD' | 'IDR';
  isIndex: boolean;
}

export interface MarketSnapshot {
  crypto: CryptoQuote[];
  usdIdr: number | null;
  stocks: StockQuote[];
  errors: string[];
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** Default watchlist saham + indeks (Yahoo v8 chart, tanpa key). */
export const DEFAULT_STOCKS = ['^JKSE', 'BBCA.JK', 'BBRI.JK', 'TLKM.JK', 'AAPL', 'NVDA', 'TSLA'];

export async function fetchYahooQuote(symbol: string): Promise<StockQuote | null> {
  try {
    const j = await fetchJson<{
      chart?: {
        result?: { meta?: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number; symbol?: string; shortName?: string; longName?: string } }[];
      };
    }>(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.toUpperCase())}?interval=1d&range=1d`, { 'user-agent': UA }, 15_000);
    const meta = j.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    const prev = meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice;
    const sym = (meta.symbol ?? symbol.toUpperCase());
    return {
      symbol: sym,
      name: meta.shortName ?? meta.longName ?? sym,
      price: meta.regularMarketPrice,
      change: prev ? ((meta.regularMarketPrice - prev) / prev) * 100 : 0,
      currency: sym.endsWith('.JK') ? 'IDR' : 'USD',
      isIndex: sym.startsWith('^'),
    };
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: string, headers: Record<string, string> = {}, timeoutMs = 20_000): Promise<T> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(to);
  }
}

export async function marketSnapshot(): Promise<MarketSnapshot> {
  const errors: string[] = [];
  const crypto: CryptoQuote[] = [];

  try {
    const headers: Record<string, string> = {};
    if (config.coingeckoKey) headers['x-cg-demo-api-key'] = config.coingeckoKey;
    const j = await fetchJson<Record<string, { usd?: number; idr?: number; usd_24h_change?: number }>>(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd,idr&include_24hr_change=true',
      headers,
    );
    for (const [id, v] of Object.entries(j)) {
      if (v.usd != null) {
        crypto.push({ id, usd: v.usd, idr: v.idr ?? 0, change24h: v.usd_24h_change ?? 0 });
      }
    }
  } catch (e) {
    errors.push(`coingecko: ${(e as Error).message}`);
  }

  let usdIdr: number | null = null;
  try {
    const j = await fetchJson<{ rates?: { IDR?: number } }>('https://api.frankfurter.dev/v1/latest?base=USD&symbols=IDR');
    if (j.rates?.IDR) usdIdr = j.rates.IDR;
  } catch (e) {
    errors.push(`frankfurter: ${(e as Error).message}`);
  }

  const stocks: StockQuote[] = [];
  const stockResults = await Promise.all(DEFAULT_STOCKS.map((s) => fetchYahooQuote(s).catch(() => null)));
  for (const s of stockResults) if (s) stocks.push(s);
  if (stockResults.every((s) => s === null)) errors.push('yahoo: semua quote saham gagal');

  if (config.twelvedataKey) {
    try {
      const j = await fetchJson<Record<string, { symbol?: string; close?: string; percent_change?: string } | { code?: number; message?: string }>>(
        `https://api.twelvedata.com/quote?symbol=AAPL,MSFT,NVDA,TSLA&apikey=${config.twelvedataKey}`,
        {},
        15_000,
      );
      for (const [sym, v] of Object.entries(j)) {
        const q = v as { symbol?: string; close?: string; percent_change?: string };
        if (q.close != null) {
          stocks.push({ symbol: q.symbol ?? sym, name: q.symbol ?? sym, price: Number(q.close), change: Number(q.percent_change ?? 0), currency: 'USD', isIndex: false });
        }
      }
    } catch (e) {
      errors.push(`twelvedata: ${(e as Error).message}`);
    }
  }

  return { crypto, usdIdr, stocks, errors };
}

export function formatStockLine(s: StockQuote): string {
  const dir = s.change >= 0 ? '🟢' : '🔴';
  const label = s.isIndex ? s.name.replace(/ Index| Composite/gi, '').toUpperCase() : s.symbol.replace('.JK', '');
  const price = s.isIndex
    ? s.price.toLocaleString('id-ID', { maximumFractionDigits: 2 })
    : s.currency === 'IDR'
      ? `Rp ${s.price.toLocaleString('id-ID', { maximumFractionDigits: 0 })}`
      : `$${s.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `${dir} ${label}: <b>${price}</b> (${s.change >= 0 ? '+' : ''}${s.change.toFixed(2)}%)`;
}

export function formatMarketLines(snap: MarketSnapshot): string {
  const lines: string[] = [];
  if (snap.usdIdr != null) lines.push(`💵 USD/IDR: <b>${snap.usdIdr.toLocaleString('id-ID', { maximumFractionDigits: 0 })}</b>`);
  const names: Record<string, string> = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL' };
  for (const c of snap.crypto) {
    const label = names[c.id] ?? c.id;
    const dir = c.change24h >= 0 ? '🟢' : '🔴';
    lines.push(`${dir} ${label}: <b>$${c.usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}</b> (${c.change24h >= 0 ? '+' : ''}${c.change24h.toFixed(2)}% 24h)`);
  }
  if (snap.stocks.length) {
    lines.push('', '<b>Saham & Indeks:</b>');
    for (const s of snap.stocks) lines.push(formatStockLine(s));
  }
  return lines.join('\n');
}
