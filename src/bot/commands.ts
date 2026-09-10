import { config } from '../config.js';
import { assertLlm } from '../config.js';
import { llmChat } from '../llm.js';
import { ddgSearch } from '../search.js';
import { db, remember, recentHistory } from '../db.js';
import { latestArticles, collectRss, articlesSince } from '../collectors/rss.js';
import { scanAiProviders, listFreeModels, newFreeModelsSince } from '../collectors/ai.js';
import { marketSnapshot, formatMarketLines } from '../collectors/market.js';
import { buildMorningDigest, buildWeeklyAiRecap } from '../digest.js';

async function cmdAsk(chatId: string, question: string): Promise<string> {
  assertLlm();
  const q = question.trim();
  if (!q) return 'Format: <code>/ask pertanyaanlu</code>';
  const searching = ddgSearch(q, 6);
  const history = recentHistory(chatId, 6);
  const hits = await searching;
  const contextBlock = hits.length
    ? hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.snippet}\n${h.url}`).join('\n\n')
    : '';
  remember(chatId, 'user', q);
  const today = new Date().toLocaleDateString('id-ID', { dateStyle: 'full', timeZone: 'Asia/Jakarta' });
  const sys = `Kamu ORACLE — asisten Telegram cerdas berbahasa Indonesia (santai tapi informatif, boleh campur istilah Inggris). Tanggal hari ini: ${today}.${
    contextBlock ? `\nHasil pencarian web real-time (DuckDuckGo):\n${contextBlock}\nGunakan info ini untuk jawaban yang up-to-date, sitasi pakai [nomor].` : '\nTidak ada hasil web — jawab dari pengetahuan, dan sebutkan bila info bisa jadi tidak terbaru.'
  }\nFormat: HTML Telegram (bold &lt;b&gt;, italic &lt;i&gt;, code &lt;code&gt;), max ~300 kata kecuali diminta detail.`
    .replace(/&lt;/g, '<');
  const r = await llmChat([...history, { role: 'system', content: sys }, { role: 'user', content: q }], { maxTokens: 2048 });
  remember(chatId, 'assistant', r.content.slice(0, 2000));
  const srcs = hits.length ? `\n\n<i>Sumber: ${hits.map((h) => `<a href="${h.url}">${h.title.slice(0, 40)}</a>`).join(' · ')}</i>` : '';
  return `${r.content}${srcs}`;
}

export async function handleUpdateText(chatId: string, text: string): Promise<string | null> {
  const parts = text.trim().split(/\s+/);
  const cmd = (parts[0] ?? '').replace(/@oracle\S*$/i, '').toLowerCase();
  const rest = text.trim().slice(cmd.length).trim();

  if (!cmd.startsWith('/')) {
    if (/^(tanya|ask)\b/i.test(text.trim())) return cmdAsk(chatId, rest);
    return null;
  }

  switch (cmd) {
    case '/start':
    case '/help':
      return [
        '<b>☀️ ORACLE — asisten pasar &amp; AI lu</b>',
        '',
        '<b>Chat AI</b>',
        '• Ketik apa aja langsung (atau /ask <i>pertanyaan</i>) — gua jawab pakai web search real-time',
        '',
        '<b>Market &amp; News</b>',
        '• /news — berita finansial terbaru (global + Indonesia)',
        '• /newsid — khusus berita Indonesia',
        '• /price — BTC/ETH/SOL, USD/IDR, saham US',
        '• /digest — morning brief lengkap (AI summary + market + headlines)',
        '',
        '<b>AI Tracker</b>',
        '• /aifree — model AI free yang gua pantau + yang baru rilis',
        '• /aiscan — scan sekarang (OpenRouter diff + repo tracker)',
        '• /airecap — rekap mingguan free AI models',
        '',
        '<b>Watchlist</b>',
        '• /watch <i>keyword</i> — pantau keyword breaking news',
        '• /unwatch <i>keyword</i> — hapus',
        '• /watchlist — lihat semua',
      ].join('\n');

    case '/ask':
      return cmdAsk(chatId, rest);

    case '/news': {
      const arts = latestArticles(null, 10);
      if (!arts.length) return 'Belum ada artikel — coba /scan dulu.';
      return `<b>📰 Finansial terbaru</b>\n\n${arts
        .map((a, i) => `${i + 1}. <a href="${a.url}">${a.title}</a> <i>${a.source}</i>`)
        .join('\n')}`;
    }

    case '/newsid': {
      const arts = latestArticles('indonesia', 10);
      if (!arts.length) return 'Belum ada artikel Indonesia — coba /scan dulu.';
      return `<b>🇮🇩 News Indonesia</b>\n\n${arts.map((a) => `• <a href="${a.url}">${a.title}</a> <i>${a.source}</i>`).join('\n')}`;
    }

    case '/price': {
      const snap = await marketSnapshot();
      const lines = formatMarketLines(snap);
      if (!lines) return `Gagal ambil data: ${snap.errors.join(' | ') || 'unknown'}`;
      return `<b>📊 Market sekarang</b>\n\n${lines}`;
    }

    case '/digest':
      return buildMorningDigest();

    case '/aifree': {
      const all = listFreeModels(15);
      const recent = newFreeModelsSince(72, 5);
      const list = all.map((m) => `• <code>${m.id}</code> — ${m.ctx ? `${(m.ctx / 1000).toFixed(0)}k ctx` : 'n/a'}`).join('\n');
      const fresh = recent.length
        ? `\n\n<b>Baru 72 jam:</b>\n${recent.map((m) => `🆕 <code>${m.id}</code>`).join('\n')}`
        : '';
      return all.length ? `<b>🆓 Free AI models dipantau (${all.length}+ terakhir)</b>\n${list}${fresh}` : 'Belum ada data — jalankan /aiscan dulu.';
    }

    case '/aiscan': {
      const r = await scanAiProviders();
      const newOnes = r.newModels.length
        ? `\n🆕 <b>Model baru terdeteksi:</b>\n${r.newModels.map((m) => `• <code>${m.id}</code> (${m.ctx ? `${(m.ctx / 1000).toFixed(0)}k ctx` : 'n/a'})`).join('\n')}`
        : '\nTidak ada model free baru.';
      const gh = r.ghUpdates.length
        ? `\n\n<b>Repo tracker update:</b>\n${r.ghUpdates.slice(0, 5).map((u) => `• <a href="${u.url}">${u.title}</a> <i>${u.repo.split('/')[1]}</i>`).join('\n')}`
        : '';
      const err = r.errors.length ? `\n<i>⚠ ${r.errors.join(' | ')}</i>` : '';
      return `Scan done. Total free models OpenRouter: <b>${r.freeModelsTotal}</b>${newOnes}${gh}${err}`;
    }

    case '/airecap':
      return buildWeeklyAiRecap();

    case '/scan': {
      const r = await collectRss();
      const ok = r.perFeed.filter((f) => f.ok);
      const bad = r.perFeed.filter((f) => !f.ok);
      return [
        `RSS scan: <b>${ok.reduce((a, f) => a + f.items, 0)} artikel baru</b> dari ${ok.length}/${r.perFeed.length} feed.`,
        bad.length ? `\n⚠ Gagal: ${bad.map((f) => `${f.source} (${f.error})`).join(', ')}` : '',
      ].join('');
    }

    case '/watch': {
      if (!rest) return 'Format: /watch <i>keyword</i>';
      try {
        db.prepare('INSERT INTO watch(keyword, created_at) VALUES(?, ?)').run(rest.toLowerCase(), new Date().toISOString());
        return `👍 Watch <code>${rest}</code> aktif. Gua ngepush kalau ada breaking news yang cocok.`;
      } catch {
        return `Keyword <code>${rest}</code> sudah dipantau.`;
      }
    }

    case '/unwatch': {
      if (!rest) return 'Format: /unwatch <i>keyword</i>';
      const res = db.prepare('DELETE FROM watch WHERE keyword = ?').run(rest.toLowerCase());
      return res.changes > 0 ? `🗑 Watch <code>${rest}</code> dihapus.` : `Keyword <code>${rest}</code> gak ada di watchlist.`;
    }

    case '/watchlist': {
      const rows = db.prepare('SELECT keyword FROM watch ORDER BY keyword').all() as { keyword: string }[];
      return rows.length
        ? `<b>👀 Watchlist</b>\n${rows.map((r) => `• <code>${r.keyword}</code>`).join('\n')}`
        : 'Watchlist kosong — tambah via /watch <i>keyword</i>';
    }

    default:
      return null;
  }
}

export { articlesSince };
