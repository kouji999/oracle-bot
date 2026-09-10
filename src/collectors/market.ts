import { config } from '../config.js';

export interface CryptoQuote {
  id: string;
  usd: number;
  idr: number;
  change24h: number;
}

export interface MarketSnapshot {
  crypto: CryptoQuote[];
  usdIdr: number | null;
  stocks: { symbol: string; price: number; change: number }[];
  errors: string[];
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

  const stocks: MarketSnapshot['stocks'] = [];
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
          stocks.push({ symbol: q.symbol ?? sym, price: Number(q.close), change: Number(q.percent_change ?? 0) });
        }
      }
    } catch (e) {
      errors.push(`twelvedata: ${(e as Error).message}`);
    }
  }

  return { crypto, usdIdr, stocks, errors };
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
  for (const s of snap.stocks) {
    const dir = s.change >= 0 ? '🟢' : '🔴';
    lines.push(`${dir} ${s.symbol}: <b>$${s.price.toFixed(2)}</b> (${s.change >= 0 ? '+' : ''}${s.change.toFixed(2)}%)`);
  }
  return lines.join('\n');
}
