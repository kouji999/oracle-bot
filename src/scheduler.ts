import { db } from './db.js';
import cron from 'node-cron';
import { collectRss, type CollectedArticle } from './collectors/rss.js';
import { scanAiProviders } from './collectors/ai.js';
import { marketSnapshot } from './collectors/market.js';
import { buildMorningDigest, buildWeeklyAiRecap } from './digest.js';
import { escapeHtml } from './util.js';
import { syncFreeLlmProviders } from './collectors/freellm.js';
import { runIntelScan } from './collectors/intel.js';
import { checkPriceWatches, watchLabel, formatPrice } from './collectors/watchprice.js';

export interface Notifier {
  send(text: string): Promise<void>;
}

const MAX_TG = 4000;

export function splitTelegram(text: string): string[] {
  if (text.length <= MAX_TG) return [text];
  const parts: string[] = [];
  let cur = '';
  for (const para of text.split('\n')) {
    if ((cur + para).length > MAX_TG) {
      if (cur) parts.push(cur);
      cur = '';
    }
    cur += para + '\n';
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

async function runRss(notify: Notifier): Promise<void> {
  const r = await collectRss();
  if (r.newArticles.length === 0) return;
  const watchers = db.prepare('SELECT keyword FROM watch').all() as { keyword: string }[];
  const hits = new Map<string, CollectedArticle[]>();
  for (const art of r.newArticles) {
    const hay = `${art.title} ${art.summary}`.toLowerCase();
    for (const w of watchers) {
      if (hay.includes(w.keyword.toLowerCase())) {
        const arr = hits.get(w.keyword) ?? [];
        arr.push(art);
        hits.set(w.keyword, arr);
      }
    }
  }
  for (const [kw, arts] of hits) {
    const lines = arts.slice(0, 5).map((a) => `• <a href="${a.url}">${escapeHtml(a.title)}</a> <i>${escapeHtml(a.source)}</i>`);
    await notify.send(`🚨 <b>Breaking — watch: ${escapeHtml(kw)}</b>\n\n${lines.join('\n')}`);
  }
}

export function startScheduler(notify: Notifier): { stop: () => void } {
  const crons: { stop: () => void }[] = [];

  crons.push(
    cron.schedule('*/30 * * * *', () => {
      void runRss(notify).catch((e) => console.error('[rss-cron]', e.message));
    }, { timezone: 'Asia/Jakarta' }),
  );

  crons.push(
    cron.schedule('5 */6 * * *', () => {
      void scanAiProviders()
        .then((r) => {
          if (r.newModels.length > 0) {
            const list = r.newModels.slice(0, 8).map((m) => `• <code>${m.id}</code> — ${m.ctx ? `${(m.ctx / 1000).toFixed(0)}k ctx` : 'n/a'}`).join('\n');
            return notify.send(`🆕 <b>Model AI gratis baru di OpenRouter (${r.freeModelsTotal} total)</b>\n\n${list}`);
          }
        })
        .catch((e) => console.error('[ai-cron]', e.message));
    }, { timezone: 'Asia/Jakarta' }),
  );

  // Intelijen free-AI provider (diff /models provider + Google News + Reddit + HN + nitter + X) — tiap jam
  crons.push(
    cron.schedule('15 * * * *', () => {
      void runIntelScan()
        .then((r) => {
          const parts: string[] = [];
          if (r.alerts.length) parts.push(`🛰 <b>Perubahan provider:</b>\n${r.alerts.slice(0, 8).join('\n')}`);
          if (r.newItems.length) {
            const top = r.newItems.slice(0, 6).map((p) => `• <a href="${p.url}">${escapeHtml(p.title.slice(0, 90))}</a> <i>${escapeHtml(p.source)}</i>`);
            parts.push(`🔎 <b>Intelijen baru (${r.newItems.length}):</b>\n${top.join('\n')}`);
          }
          if (parts.length) return notify.send(parts.join('\n\n'));
        })
        .catch((e) => console.error('[intel-cron]', e.message));
    }, { timezone: 'Asia/Jakarta' }),
  );

  // Sinkronisasi direktori provider (awesome-freellm-apis) — 2x sehari
  crons.push(
    cron.schedule('40 5,17 * * *', () => {
      void syncFreeLlmProviders()
        .then((s) => {
          if (!s.ok) return console.error('[prov-cron] sync gagal:', s.error);
          const notable = s.events.filter((e) => e.type === 'new_provider' || (e.type === 'models_up' && (e.to ?? 0) - (e.from ?? 0) >= 5));
          if (notable.length > 0) {
            const list = notable.slice(0, 6).map((e) => `• ${e.type === 'new_provider' ? `BARU <b>${escapeHtml(e.name)}</b> (${e.to} model)` : `${escapeHtml(e.name)}: ${e.from} → ${e.to} model`}`).join('\n');
            return notify.send(`🧩 <b>Perbaruan direktori provider AI</b>\n\n${list}`);
          }
        })
        .catch((e) => console.error('[prov-cron]', e.message));
    }, { timezone: 'Asia/Jakarta' }),
  );

  crons.push(
    cron.schedule('30 6 * * *', () => {
      void buildMorningDigest()
        .then((d) => notify.send(d))
        .catch((e) => console.error('[digest-cron]', e.message));
    }, { timezone: 'Asia/Jakarta' }),
  );

  crons.push(
    cron.schedule('0 9 * * 1', () => {
      void buildWeeklyAiRecap()
        .then((r) => notify.send(r))
        .catch((e) => console.error('[weekly-cron]', e.message));
    }, { timezone: 'Asia/Jakarta' }),
  );

  // Pemantau harga (threshold) — tiap 30 menit bareng RSS
  crons.push(
    cron.schedule('20,50 * * * *', () => {
      void checkPriceWatches()
        .then((fired) => {
          if (!fired.length) return;
          const lines = fired.map((f) => `• <b>${watchLabel(f.target)}</b> sekarang <b>${formatPrice(f.target, f.value, f.currency, f.isIndex)}</b> (${f.op} ${f.threshold.toLocaleString('id-ID')})`);
          return notify.send(`🚨 <b>Peringatan Harga</b>\n\n${lines.join('\n')}\n\n<i>Setup ulang: /watchprice · hapus: /unwatchprice</i>`);
        })
        .catch((e) => console.error('[price-cron]', e.message));
    }, { timezone: 'Asia/Jakarta' }),
  );

  return { stop: () => crons.forEach((c) => c.stop()) };
}

export async function runInitialCollect(): Promise<string> {
  const [rssR] = await Promise.all([
    collectRss(),
    scanAiProviders().catch(() => undefined),
    syncFreeLlmProviders().catch(() => undefined),
    runIntelScan().catch(() => undefined),
    marketSnapshot().catch(() => undefined),
  ]);
  const ok = rssR.perFeed.filter((f) => f.ok);
  const bad = rssR.perFeed.filter((f) => !f.ok);
  return `Boot: ${ok.reduce((a, f) => a + f.items, 0)} artikel baru (${ok.length}/${rssR.perFeed.length} kanal) + provider directory & X intel tersinkron${bad.length ? ` · gagal: ${bad.map((f) => f.source).join(', ')}` : ''}`;
}
