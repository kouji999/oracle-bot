import { db } from './db.js';
import cron from 'node-cron';
import { collectRss, articlesSince, type CollectedArticle } from './collectors/rss.js';
import { scanAiProviders } from './collectors/ai.js';
import { marketSnapshot } from './collectors/market.js';
import { buildMorningDigest, buildWeeklyAiRecap } from './digest.js';
import { escapeHtml } from './util.js';

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
            return notify.send(`🆓 <b>Free AI model baru di OpenRouter (${r.freeModelsTotal} total)</b>\n\n${list}`);
          }
        })
        .catch((e) => console.error('[ai-cron]', e.message));
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

  return { stop: () => crons.forEach((c) => c.stop()) };
}

export async function runInitialCollect(): Promise<string> {
  const r = await collectRss();
  await scanAiProviders().catch(() => undefined);
  await marketSnapshot().catch(() => undefined);
  const ok = r.perFeed.filter((f) => f.ok);
  const bad = r.perFeed.filter((f) => !f.ok);
  return `Boot collect: ${ok.reduce((a, f) => a + f.items, 0)} artikel baru (${ok.length}/${r.perFeed.length} feed ok)${bad.length ? ` · gagal: ${bad.map((f) => f.source).join(', ')}` : ''}`;
}
