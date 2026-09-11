import { config } from '../config.js';
import { escapeHtml } from '../util.js';
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
  const sys = `Kamu ORACLE â€” asisten Telegram cerdas berbahasa Indonesia (santai tapi informatif, boleh campur istilah Inggris). Tanggal hari ini: ${today}.${
    contextBlock ? `\nHasil pencarian web real-time (DuckDuckGo):\n${contextBlock}\nGunakan info ini untuk jawaban yang up-to-date, sitasi pakai [nomor].` : '\nTidak ada hasil web â€” jawab dari pengetahuan, dan sebutkan bila info bisa jadi tidak terbaru.'
  }\nFormat: HTML Telegram (bold &lt;b&gt;, italic &lt;i&gt;, code &lt;code&gt;), max ~300 kata kecuali diminta detail.`
    .replace(/&lt;/g, '<');
  const r = await llmChat([...history, { role: 'system', content: sys }, { role: 'user', content: q }], { maxTokens: 2048 });
  remember(chatId, 'assistant', r.content.slice(0, 2000));
  const srcs = hits.length ? `\n\n<i>Sumber: ${hits.map((h) => `<a href="${h.url}">${h.title.slice(0, 40)}</a>`).join(' Â· ')}</i>` : '';
  return `${r.content}${srcs}`;
}

export async function handleUpdateText(chatId: string, text: string): Promise<string | null> {
  const parts = text.trim().split(/\s+/);
  const cmd = (parts[0] ?? '').replace(/@oracle\S*$/i, '').toLowerCase();
  const rest = text.trim().slice(cmd.length).trim();

  if (!cmd.startsWith('/')) {
    // chat bebas = auto-ask dengan grounding web search
    return cmdAsk(chatId, text.trim());
  }

  switch (cmd) {
    case '/start':
    case '/help':
      return [
        '<b>â˜€ï¸ ORACLE â€” asisten pasar &amp; AI lu</b>',
        '',
        '<b>Chat AI</b>',
        'â€¢ Ketik apa aja langsung (atau /ask <i>pertanyaan</i>) â€” gua jawab pakai web search real-time',
        '',
        '<b>Market &amp; News</b>',
        'â€¢ /news â€” berita finansial terbaru (global + Indonesia)',
        'â€¢ /newsid â€” khusus berita Indonesia',
        'â€¢ /price â€” BTC/ETH/SOL, USD/IDR, saham US',
        'â€¢ /digest â€” morning brief lengkap (AI summary + market + headlines)',
        '',
        '<b>AI Tracker</b>',
        'â€¢ /aifree â€” model AI free yang gua pantau + yang baru rilis',
        'â€¢ /aiscan â€” scan sekarang (OpenRouter diff + repo tracker)',
        'â€¢ /airecap â€” rekap mingguan free AI models',
        '',
        '<b>Watchlist</b>',
        'â€¢ /watch <i>keyword</i> â€” pantau keyword breaking news',
        'â€¢ /unwatch <i>keyword</i> â€” hapus',
        'â€¢ /watchlist â€” lihat semua',
      ].join('\n');

    case '/ask':
      return cmdAsk(chatId, rest);

    case '/news': {
      const arts = latestArticles(null, 10);
      if (!arts.length) return 'Belum ada artikel â€” coba /scan dulu.';
      return `<b>ðŸ“° Finansial terbaru</b>\n\n${arts
        .map((a, i) => `${i + 1}. <a href="${a.url}">${escapeHtml(a.title)}</a> <i>${escapeHtml(a.source)}</i>`)
        .join('\n')}`;
    }

    case '/newsid': {
      const arts = latestArticles('indonesia', 10);
      if (!arts.length) return 'Belum ada artikel Indonesia â€” coba /scan dulu.';
      return `<b>ðŸ‡®ðŸ‡© News Indonesia</b>\n\n${arts.map((a) => `â€¢ <a href="${a.url}">${a.title}</a> <i>${a.source}</i>`).join('\n')}`;
    }

    case '/price': {
      const snap = await marketSnapshot();
      const lines = formatMarketLines(snap);
      if (!lines) return `Gagal ambil data: ${snap.errors.join(' | ') || 'unknown'}`;
      return `<b>ðŸ“Š Market sekarang</b>\n\n${lines}`;
    }

    case '/digest':
      return buildMorningDigest();

    case '/aifree': {
      const all = listFreeModels(15);
      const recent = newFreeModelsSince(72, 5);
      const list = all.map((m) => `â€¢ <code>${m.id}</code> â€” ${m.ctx ? `${(m.ctx / 1000).toFixed(0)}k ctx` : 'n/a'}`).join('\n');
      const fresh = recent.length
        ? `\n\n<b>Baru 72 jam:</b>\n${recent.map((m) => `ðŸ†• <code>${m.id}</code>`).join('\n')}`
        : '';
      return all.length ? `<b>ðŸ†“ Free AI models dipantau (${all.length}+ terakhir)</b>\n${list}${fresh}` : 'Belum ada data â€” jalankan /aiscan dulu.';
    }

    case '/aiscan': {
      const r = await scanAiProviders();
      const newOnes = r.newModels.length
        ? `\nðŸ†• <b>Model baru terdeteksi:</b>\n${r.newModels.map((m) => `â€¢ <code>${m.id}</code> (${m.ctx ? `${(m.ctx / 1000).toFixed(0)}k ctx` : 'n/a'})`).join('\n')}`
        : '\nTidak ada model free baru.';
      const gh = r.ghUpdates.length
        ? `\n\n<b>Repo tracker update:</b>\n${r.ghUpdates.slice(0, 5).map((u) => `â€¢ <a href="${u.url}">${u.title}</a> <i>${u.repo.split('/')[1]}</i>`).join('\n')}`
        : '';
      const err = r.errors.length ? `\n<i>âš  ${r.errors.join(' | ')}</i>` : '';
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
        bad.length ? `\nâš  Gagal: ${bad.map((f) => `${f.source} (${f.error})`).join(', ')}` : '',
      ].join('');
    }

    case '/watch': {
      if (!rest) return 'Format: /watch <i>keyword</i>';
      try {
        db.prepare('INSERT INTO watch(keyword, created_at) VALUES(?, ?)').run(rest.toLowerCase(), new Date().toISOString());
        return `ðŸ‘ Watch <code>${rest}</code> aktif. Gua ngepush kalau ada breaking news yang cocok.`;
      } catch {
        return `Keyword <code>${escapeHtml(rest)}</code> sudah dipantau.`;
      }
    }

    case '/unwatch': {
      if (!rest) return 'Format: /unwatch <i>keyword</i>';
      const res = db.prepare('DELETE FROM watch WHERE keyword = ?').run(rest.toLowerCase());
      return res.changes > 0 ? `ðŸ—‘ Watch <code>${rest}</code> dihapus.` : `Keyword <code>${escapeHtml(rest)}</code> gak ada di watchlist.`;
    }

    case '/watchlist': {
      const rows = db.prepare('SELECT keyword FROM watch ORDER BY keyword').all() as { keyword: string }[];
      return rows.length
        ? `<b>ðŸ‘€ Watchlist</b>\n${rows.map((r) => `â€¢ <code>${r.keyword}</code>`).join('\n')}`
        : 'Watchlist kosong â€” tambah via /watch <i>keyword</i>';
    }

    default:
      return null;
  }
}

export { articlesSince };
