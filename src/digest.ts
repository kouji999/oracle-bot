import { llmChat } from './llm.js';
import { articlesSince } from './collectors/rss.js';
import { newFreeModelsSince } from './collectors/ai.js';
import { marketSnapshot, formatMarketLines } from './collectors/market.js';
import { db } from './db.js';

export async function buildMorningDigest(): Promise<string> {
  const [snap, arts, aiNew] = await Promise.all([
    marketSnapshot(),
    Promise.resolve(articlesSince(20, undefined, 30)),
    Promise.resolve(newFreeModelsSince(48, 6)),
  ]);

  const market = formatMarketLines(snap);
  const headlines = arts
    .slice(0, 14)
    .map((a, i) => `${i + 1}. <a href="${a.url}">${a.title}</a> <i>(${a.source})</i>`)
    .join('\n');
  const ai = aiNew.length
    ? aiNew.map((m) => `• <code>${m.id}</code> — ${m.ctx ? `${(m.ctx / 1000).toFixed(0)}k ctx` : 'ctx n/a'}`).join('\n')
    : 'Tidak ada model free baru 48 jam terakhir.';

  const rawBlock = `MARKET:\n${market.replace(/<[^>]+>/g, '')}\n\nHEADLINES:\n${arts.slice(0, 14).map((a) => `- [${a.source}] ${a.title}: ${a.summary}`).join('\n')}\n\nNEW FREE AI MODELS (OpenRouter):\n${aiNew.length ? aiNew.map((m) => `- ${m.id} (${m.ctx} ctx)`).join('\n') : 'none'}`;

  let summary = '';
  try {
    const r = await llmChat(
      [
        {
          role: 'system',
          content:
            'Kamu analis pasar keuangan. Buat ringkasan pagi (bahasa Indonesia santai-profesional) max 140 kata. Struktur: (1) nada pasar hari ini dari data, (2) 3-4 poin berita paling penting global+indonesia, (3) 1 kalimat insight/kalender. Gunakan HTML minimal (<b>, <i>) tanpa heading. Jangan pakai emoji berlebihan, max 3.',
        },
        { role: 'user', content: rawBlock },
      ],
      { maxTokens: 8192, temperature: 0.4 },
    );
    summary = r.content;
  } catch {
    summary = '<i>Ringkasan AI tidak tersedia (LLM down), lihat headline mentah di bawah.</i>';
  }

  const today = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });
  return [
    `☀️ <b>ORACLE Morning Brief — ${today}</b>`,
    '',
    summary,
    '',
    `<b>📊 Market</b>\n${market || 'n/a'}`,
    '',
    `<b>📰 Headlines</b>\n${headlines || 'tidak ada artikel baru'}`,
    '',
    `<b>🆓 AI Free Models (48h)</b>\n${ai}`,
  ].join('\n');
}

export async function buildWeeklyAiRecap(): Promise<string> {
  const rows = db
    .prepare("SELECT model_id, name, ctx, first_seen FROM ai_models WHERE provider = 'openrouter' AND first_seen >= ? ORDER BY first_seen DESC LIMIT 40")
    .all(new Date(Date.now() - 7 * 86400_000).toISOString()) as { model_id: string; name: string; ctx: number; first_seen: string }[];

  const total = (db.prepare("SELECT COUNT(*) c FROM ai_models WHERE provider = 'openrouter'").get() as { c: number }).c;

  let recap = '';
  try {
    const r = await llmChat(
      [
        { role: 'system', content: 'Ringkas tren free AI model minggu ini dalam bahasa Indonesia, max 100 kata, HTML <b>/<i> boleh. Fokus: provider/label apa yang rilis apa.' },
        { role: 'user', content: rows.length ? rows.map((m) => `- ${m.model_id} (${m.ctx} ctx)`).join('\n') : 'Tidak ada model baru minggu ini.' },
      ],
      { maxTokens: 8192, temperature: 0.4 },
    );
    recap = r.content;
  } catch {
    recap = '<i>LLM tidak tersedia.</i>';
  }

  const list = rows.slice(0, 20).map((m) => `• <code>${m.model_id}</code> — ${m.ctx ? `${(m.ctx / 1000).toFixed(0)}k ctx` : 'n/a'}`).join('\n');
  return [
    '🤖 <b>ORACLE Weekly AI Recap</b>',
    '',
    `Total model free terpantau: <b>${total}</b> · Baru minggu ini: <b>${rows.length}</b>`,
    '',
    recap,
    rows.length ? `\n<b>Model baru minggu ini:</b>\n${list}` : '',
  ].join('\n');
}
