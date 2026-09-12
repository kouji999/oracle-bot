import { llmChat } from './llm.js';
import { articlesSince } from './collectors/rss.js';
import { newFreeModelsSince } from './collectors/ai.js';
import { marketSnapshot, formatMarketLines } from './collectors/market.js';
import { latestIntel } from './collectors/intel.js';
import { db } from './db.js';
import { escapeHtml } from './util.js';

export async function buildMorningDigest(): Promise<string> {
  const [snap, arts, aiNew, intel] = await Promise.all([
    marketSnapshot(),
    Promise.resolve(articlesSince(20, undefined, 30)),
    Promise.resolve(newFreeModelsSince(48, 6)),
    Promise.resolve(latestIntel(8, 48)),
  ]);

  const market = formatMarketLines(snap);
  const headlines = arts
    .slice(0, 14)
    .map((a, i) => `${i + 1}. <a href="${a.url}">${escapeHtml(a.title)}</a> <i>(${escapeHtml(a.source)})</i>`)
    .join('\n');
  const ai = aiNew.length
    ? aiNew.map((m) => `• <code>${m.id}</code> — ${m.ctx ? `${(m.ctx / 1000).toFixed(0)}k ctx` : 'ctx n/a'}`).join('\n')
    : 'Tidak ada model gratis baru dalam 48 jam terakhir.';
  const xBlock = intel.length
    ? intel.map((p) => `• <a href="${p.url}">${escapeHtml(p.title.slice(0, 90))}</a> <i>${escapeHtml(p.source)}</i>`).join('\n')
    : 'Tidak ada intelijen 48 jam terakhir.';

  const rawBlock = [
    'MARKET:',
    market.replace(/<[^>]+>/g, ''),
    '',
    'HEADLINES:',
    arts.slice(0, 14).map((a) => `- [${a.source}] ${a.title}: ${a.summary}`).join('\n'),
    '',
    'NEW FREE AI MODELS (OpenRouter):',
    aiNew.length ? aiNew.map((m) => `- ${m.id} (${m.ctx} ctx)`).join('\n') : 'none',
    '',
    'INTEL (sinyal provider AI dari X/Reddit/HN/news):',
    intel.length ? intel.map((p) => `- [${p.source}] ${p.title}: ${p.snippet}`).join('\n') : 'none',
  ].join('\n');

  let summary = '';
  try {
    const r = await llmChat(
      [
        {
          role: 'system',
          content:
            'Anda adalah analis pasar keuangan. Susun ringkasan pagi dalam Bahasa Indonesia formal-profesional, maksimal 140 kata, gaya analis institusional. Struktur: (1) nada pasar hari ini berdasarkan data, (2) 3-4 developments terpenting global dan Indonesia, (3) satu kalimat wawasan/kalender ekonomi. Format HTML minimal (<b>, <i>), tanpa heading. Maksimal 3 emoji, hanya bila relevan.',
        },
        { role: 'user', content: rawBlock },
      ],
      { maxTokens: 8192, temperature: 0.4 },
    );
    summary = r.content;
  } catch {
    summary = '<i>Ringkasan analitis tidak tersedia (LLM tidak responsif) — tautan berita di bawah merupakan data mentah.</i>';
  }

  const today = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });
  return [
    `<b>☀️ ORACLE — Morning Brief | ${today}</b>`,
    '',
    summary,
    '',
    `<b>📊 Pasar</b>\n${market || 'n/a'}`,
    '',
    `<b>📰 Headline</b>\n${headlines || 'tidak ada artikel baru'}`,
    '',
    `<b>🐦 Intelijen X — AI Provider</b>\n${xBlock}`,
    '',
    `<b>🆓 AI — model gratis baru (48 jam)</b>\n${ai}`,
  ].join('\n');
}

export async function buildWeeklyAiRecap(): Promise<string> {
  const rows = db
    .prepare("SELECT model_id, name, ctx, first_seen FROM ai_models WHERE provider = 'openrouter' AND first_seen >= ? ORDER BY first_seen DESC LIMIT 40")
    .all(new Date(Date.now() - 7 * 86400_000).toISOString()) as { model_id: string; name: string; ctx: number; first_seen: string }[];

  const total = (db.prepare("SELECT COUNT(*) c FROM ai_models WHERE provider = 'openrouter'").get() as { c: number }).c;
  const xPosts = latestIntel(8, 24 * 7);

  let recap = '';
  try {
    const r = await llmChat(
      [
        { role: 'system', content: 'Anda analis ekosistem AI. Ringkas tren model AI gratis minggu ini dalam Bahasa Indonesia formal, maksimal 100 kata. Boleh HTML <b>/<i>. Fokus: provider apa saja yang merilis model gratis dan pola yang terlihat.' },
        { role: 'user', content: (rows.length ? rows.map((m) => `- ${m.model_id} (${m.ctx} ctx)`).join('\n') : 'Tidak ada model baru.') + '\n\nSinyal dari X:\n' + (xPosts.length ? xPosts.map((p) => `- ${p.title}: ${p.snippet}`).join('\n') : 'tidak ada') },
      ],
      { maxTokens: 8192, temperature: 0.4 },
    );
    recap = r.content;
  } catch {
    recap = '<i>Ringkasan tidak tersedia (LLM tidak responsif).</i>';
  }

  const list = rows.slice(0, 20).map((m) => `• <code>${m.model_id}</code> — ${m.ctx ? `${(m.ctx / 1000).toFixed(0)}k ctx` : 'n/a'}`).join('\n');
  const xBlock = xPosts.length ? `\n<b>Sinyal X minggu ini:</b>\n${xPosts.slice(0, 5).map((p) => `• <a href="${p.url}">${escapeHtml(p.title.slice(0, 90))}</a>`).join('\n')}` : '';
  return [
    '<b>🤖 ORACLE — Weekly AI Recap</b>',
    '',
    `Model gratis terpantau: <b>${total}</b> · Baru minggu ini: <b>${rows.length}</b>`,
    '',
    recap,
    rows.length ? `\n<b>Daftar model baru:</b>\n${list}` : '',
    xBlock,
  ].join('\n');
}
