import { db } from '../db.js';
import { marketSnapshot, fetchYahooQuote, type MarketSnapshot, type StockQuote } from './market.js';

/**
 * watchprice.ts — price threshold alerts.
 * Target: crypto (btc/eth/sol), kurs (usdidr), saham/indeks Yahoo (aapl, nvda, bbca.jk, ^jkse).
 * state 0 = belum fire, 1 = sudah fire (sekali per setup, hindari spam; set ulang untuk re-arm).
 */

const CRYPTO: Record<string, (snap: MarketSnapshot) => number | null> = {
  btc: (s) => s.crypto.find((c) => c.id === 'bitcoin' || c.id === 'btc')?.usd ?? null,
  eth: (s) => s.crypto.find((c) => c.id === 'ethereum' || c.id === 'eth')?.usd ?? null,
  sol: (s) => s.crypto.find((c) => c.id === 'solana' || c.id === 'sol')?.usd ?? null,
  usdidr: (s) => s.usdIdr,
};

const SYMBOL_RE = /^(?:[A-Za-z][A-Za-z0-9.\-]{0,14}|\^[A-Za-z][A-Za-z0-9.\-]{0,14})$/;
const OPS: Record<string, (v: number, t: number) => boolean> = {
  above: (v, t) => v > t,
  below: (v, t) => v < t,
};

export function watchLabel(target: string): string {
  if (target === 'usdidr') return 'USD/IDR';
  if (target.startsWith('^')) return 'IHSG';
  return target.toUpperCase().replace('.JK', '');
}

function priceOfCrypto(snap: MarketSnapshot, target: string): number | null {
  return CRYPTO[target]?.(snap) ?? null;
}

export async function addPriceWatch(target: string, op: string, threshold: number): Promise<string> {
  const key = target.toLowerCase();
  if (!(op in OPS)) return 'Operator harus <code>above</code> atau <code>below</code>.';
  if (!Number.isFinite(threshold) || threshold <= 0) return 'Threshold harus angka positif.';
  if (key !== 'usdidr' && !/^\d/.test(key) && !SYMBOL_RE.test(key)) return 'Symbol tidak valid. Contoh: btc, eth, sol, usdidr, aapl, bbca.jk, ^jkse.';

  // validasi: pastikan harga bisa diambil
  let current: number | null = null;
  if (key in CRYPTO) {
    const snap = await marketSnapshot();
    current = priceOfCrypto(snap, key);
  } else {
    const q = await fetchYahooQuote(key);
    current = q?.price ?? null;
  }
  if (current == null) return `Tidak bisa ambil harga untuk <code>${key}</code> — cek symbol (saham ID pakai suffix .jk, mis. bbca.jk; indeks: ^jkse).`;

  const existing = db.prepare('SELECT 1 FROM price_watch WHERE target = ?').get(key);
  db.prepare(
    `INSERT INTO price_watch(target, op, threshold, state, created_at) VALUES(?,?,?,?,?)
     ON CONFLICT(target) DO UPDATE SET op = excluded.op, threshold = excluded.threshold, state = 0, created_at = excluded.created_at, fired_at = NULL`,
  ).run(key, op, threshold, 0, new Date().toISOString());
  const cur = key === 'usdidr' ? `Rp ${current.toLocaleString('id-ID', { maximumFractionDigits: 0 })}` : `$${current.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `${existing ? '✓ Pemantauan diperbarui' : '✓ Pemantauan aktif'}: <b>${watchLabel(key)}</b> <code>${op} ${threshold.toLocaleString('id-ID')}</code> (sekarang: ${cur}). Bot akan memberi tahu sekali saat terpicu.`;
}

export function removePriceWatch(target: string): string {
  const r = db.prepare('DELETE FROM price_watch WHERE target = ?').run(target.toLowerCase());
  return r.changes > 0 ? `🗑 Pemantauan harga <b>${watchLabel(target)}</b> dihapus.` : `Tidak ada pemantauan untuk <b>${target.toUpperCase()}</b>.`;
}

export function listPriceWatches(): string {
  const rows = db.prepare('SELECT target, op, threshold, state, fired_at FROM price_watch').all() as { target: string; op: string; threshold: number; state: number; fired_at: string | null }[];
  if (!rows.length) return 'Belum ada pemantauan harga. Tambahkan: <code>/watchprice btc above 100000</code> · <code>/watchprice ^jkse below 6400</code> · <code>/watchprice aapl above 340</code>';
  return (
    '• <b>Harga</b>\n' +
    rows.map((r) => `  <b>${watchLabel(r.target)}</b> ${r.op} ${r.threshold.toLocaleString('id-ID')}${r.state ? ` — <i>terpicu ${r.fired_at ? new Date(r.fired_at).toLocaleDateString('id-ID') : ''}</i>` : ''}`).join('\n')
  );
}

export interface PriceAlert {
  target: string;
  op: string;
  threshold: number;
  value: number;
  currency: 'USD' | 'IDR';
  isIndex: boolean;
}

export function formatPrice(target: string, value: number, currency: 'USD' | 'IDR', isIndex = false): string {
  if (isIndex) return value.toLocaleString('id-ID', { maximumFractionDigits: 2 });
  if (currency === 'IDR') return `Rp ${value.toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: target === 'usdidr' ? 0 : 2 })}`;
}

/** Cron tiap 30 menit. Crypto/kurs pakai satu snapshot; saham per symbol (lazy). */
export async function checkPriceWatches(): Promise<PriceAlert[]> {
  const rows = db.prepare('SELECT target, op, threshold FROM price_watch WHERE state = 0').all() as { target: string; op: string; threshold: number }[];
  if (!rows.length) return [];

  let snap: MarketSnapshot | null = null;
  const stockCache = new Map<string, StockQuote | null>();
  const fired: PriceAlert[] = [];

  for (const r of rows) {
    let v: number | null = null;
    let currency: 'USD' | 'IDR' = r.target === 'usdidr' ? 'IDR' : 'USD';
    let isIndex = r.target.startsWith('^');
    if (r.target in CRYPTO) {
      snap ??= await marketSnapshot();
      v = priceOfCrypto(snap, r.target);
    } else {
      if (!stockCache.has(r.target)) stockCache.set(r.target, await fetchYahooQuote(r.target).catch(() => null));
      const q = stockCache.get(r.target);
      v = q?.price ?? null;
      currency = q?.currency ?? 'USD';
      isIndex = q?.isIndex ?? isIndex;
    }
    if (v == null) continue;
    const test = OPS[r.op];
    if (test && test(v, r.threshold)) {
      db.prepare('UPDATE price_watch SET state = 1, fired_at = ? WHERE target = ?').run(new Date().toISOString(), r.target);
      fired.push({ target: r.target, op: r.op, threshold: r.threshold, value: v, currency, isIndex });
    }
  }
  return fired;
}
