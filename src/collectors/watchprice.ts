import { db } from '../db.js';
import { marketSnapshot, type MarketSnapshot } from './market.js';

/**
 * watchprice.ts — price threshold alerts (crypto USD, USD/IDR).
 * state 0 = belum fire, 1 = sudah fire (sekali saja per setup, hindari spam).
 * Format target: "btc" | "eth" | "sol" | "usdidr".
 */

const OPS: Record<string, (v: number, t: number) => boolean> = {
  above: (v, t) => v > t,
  below: (v, t) => v < t,
};

const PRICE_OF = (snap: MarketSnapshot, target: string): number | null => {
  const k = target.toLowerCase();
  if (k === 'usdidr') return snap.usdIdr;
  const c = snap.crypto.find((x) => x.id === k || (k === 'btc' && x.id === 'bitcoin') || (k === 'eth' && x.id === 'ethereum') || (k === 'sol' && x.id === 'solana'));
  return c?.usd ?? null;
};

export function addPriceWatch(target: string, op: string, threshold: number): string {
  const key = target.toLowerCase();
  const valid = ['btc', 'eth', 'sol', 'usdidr'];
  if (!valid.includes(key)) return `Target tidak dikenal. Pilihan: ${valid.join(' / ')}.`;
  if (!(op in OPS)) return 'Operator harus <code>above</code> atau <code>below</code>.';
  if (!Number.isFinite(threshold) || threshold <= 0) return 'Threshold harus angka positif.';
  const existing = db.prepare('SELECT 1 FROM price_watch WHERE target = ?').get(key);
  db.prepare(
    `INSERT INTO price_watch(target, op, threshold, state, created_at) VALUES(?,?,?,?,?)
     ON CONFLICT(target) DO UPDATE SET op = excluded.op, threshold = excluded.threshold, state = 0, created_at = excluded.created_at, fired_at = NULL`,
  ).run(key, op, threshold, 0, new Date().toISOString());
  return existing ? `✓ Pemantauan harga <b>${key.toUpperCase()}</b> diperbarui: <code>${op} $/Rp ${threshold.toLocaleString('id-ID')}</code>.` : `✓ Pemantauan harga <b>${key.toUpperCase()}</b> aktif: <code>${op} ${threshold.toLocaleString('id-ID')}</code>. Bot akan memberi tahu sekali saat terpicu.`;
}

export function removePriceWatch(target: string): string {
  const r = db.prepare('DELETE FROM price_watch WHERE target = ?').run(target.toLowerCase());
  return r.changes > 0 ? `🗑 Pemantauan harga <b>${target.toUpperCase()}</b> dihapus.` : `Tidak ada pemantauan untuk <b>${target.toUpperCase()}</b>.`;
}

export function listPriceWatches(): string {
  const rows = db.prepare('SELECT target, op, threshold, state, fired_at FROM price_watch').all() as { target: string; op: string; threshold: number; state: number; fired_at: string | null }[];
  if (!rows.length) return 'Belum ada pemantauan harga. Tambahkan: <code>/watchprice btc above 100000</code>';
  return rows
    .map((r) => `• <b>${r.target.toUpperCase()}</b> ${r.op} ${r.threshold.toLocaleString('id-ID')}${r.state ? ` — <i>terpicu ${r.fired_at ? new Date(r.fired_at).toLocaleDateString('id-ID') : ''}</i>` : ''}`)
    .join('\n');
}

export interface PriceAlert {
  target: string;
  op: string;
  threshold: number;
  value: number;
}

/** Dipanggil dari scheduler tiap 30 menit (bareng cron market). */
export async function checkPriceWatches(): Promise<PriceAlert[]> {
  const rows = db.prepare('SELECT target, op, threshold FROM price_watch WHERE state = 0').all() as { target: string; op: string; threshold: number }[];
  if (!rows.length) return [];
  const snap = await marketSnapshot();
  const fired: PriceAlert[] = [];
  for (const r of rows) {
    const v = PRICE_OF(snap, r.target);
    if (v == null) continue;
    const test = OPS[r.op];
    if (test && test(v, r.threshold)) {
      db.prepare('UPDATE price_watch SET state = 1, fired_at = ? WHERE target = ?').run(new Date().toISOString(), r.target);
      fired.push({ target: r.target, op: r.op, threshold: r.threshold, value: v });
    }
  }
  return fired;
}
