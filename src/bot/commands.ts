import { config } from '../config.js';
import { assertLlm } from '../config.js';
import { escapeHtml } from '../util.js';
import { llmChat } from '../llm.js';
import { ddgSearch } from '../search.js';
import { db, kvGet, remember, recentHistory } from '../db.js';
import { latestArticles, collectRss } from '../collectors/rss.js';
import { scanAiProviders, listFreeModels, newFreeModelsSince } from '../collectors/ai.js';
import { syncFreeLlmProviders, listProviders, findProvider, type ProviderRow } from '../collectors/freellm.js';
import { scanX, latestXPosts } from '../collectors/xai.js';
import { marketSnapshot, formatMarketLines } from '../collectors/market.js';
import { buildMorningDigest, buildWeeklyAiRecap } from '../digest.js';

const ANSWER_MAX_TOKENS = 8192;

async function cmdAsk(chatId: string, question: string): Promise<string> {
  assertLlm();
  const q = question.trim();
  if (!q) return 'Gunakan format: <code>/ask &lt;pertanyaan Anda&gt;</code>';
  const hits = await ddgSearch(q, 6);
  const history = recentHistory(chatId, 6);
  const contextBlock = hits.length
    ? hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.snippet}\n${h.url}`).join('\n\n')
    : '';
  remember(chatId, 'user', q);
  const wantsProviders = /(provider|free|gratis|base ?url|api[ _-]?key|9router|openrouter|groq|gemini|cerebras|nim|ollama|token|model.*(baru|free|gratis)|kredit)/i.test(q);
  let providerCtx = '';
  if (wantsProviders) {
    const provs = listProviders()
      .map((p) => `${p.name} | ${p.baseUrl ?? 'n/a'} | ${p.freeModels ?? '?'} model gratis | syarat: ${p.creditCard ?? 'n/a'} | best: ${p.bestModelId ?? 'n/a'}`)
      .join('\n');
    const models = listFreeModels(20).map((m) => m.id).join(', ');
    const xPosts = latestXPosts(6, 24 * 7).map((p) => p.title).join('\n');
    providerCtx =
      `\n\nDATA LOKAL ORACLE (sinkron otomatis — prioritaskan ini):\n` +
      `<b>Direktori provider gratis:</b>\n${provs}\n\n` +
      `<b>Model gratis OpenRouter:</b> ${models}\n\n` +
      `<b>Sinyal X terbaru:</b>\n${xPosts}\n` +
      `Jika user bertanya provider mana yang cocok, rekomendasikan dari direktori di atas (base URL + model + syarat), bandingkan rate limit/kartu, dan arahkan ke /prov <nama> untuk snippet config.`;
  }
  const today = new Date().toLocaleDateString('id-ID', { dateStyle: 'full', timeZone: 'Asia/Jakarta' });
  const sys =
    `Anda adalah ORACLE, asisten riset pasar dan teknologi AI. Bahasa: Indonesia formal-profesional, ringkas, informatif; istilah teknis Inggris tetap. Tanggal hari ini: ${today}.` +
    (contextBlock
      ? `\nHasil pencarian web (real-time):\n${contextBlock}\nGunakan sebagai sumber utama; sitasi dengan [nomor].`
      : '\nPencarian web tidak menghasilkan data — jawab berdasarkan pengetahuan Anda dan sebutkan bahwa informasi dapat sudah tidak mutakhir.') +
    providerCtx +
    '\nFormat: HTML Telegram (<b>, <i>, <code>). Maksimal ~300 kata kecuali diminta lebih rinci.';
  const r = await llmChat([{ role: 'system', content: sys }, ...history, { role: 'user', content: q }], { maxTokens: ANSWER_MAX_TOKENS });
  remember(chatId, 'assistant', r.content.slice(0, 2000));
  const srcs = hits.length
    ? `\n\n<i>Sumber: ${hits.map((h) => `<a href="${h.url}">${escapeHtml(h.title.slice(0, 40))}</a>`).join(' · ')}</i>`
    : '';
  return `${r.content}${srcs}`;
}

function xPostsText(posts: { title: string; url: string; snippet: string }[]): string {
  return posts
    .map((p) => `• <a href="${p.url}">${escapeHtml(p.title.slice(0, 90))}</a>${p.snippet ? `\n  ${escapeHtml(p.snippet.slice(0, 140))}` : ''}`)
    .join('\n');
}

function provDetail(p: ProviderRow): string {
  const rows: string[] = [
    `<b>🧩 ${escapeHtml(p.name)}</b>`,
    '',
    p.baseUrl ? `• Base URL: <code>${escapeHtml(p.baseUrl)}</code>` : '',
    p.bestModelId ? `• Model gratis terbaik: <code>${escapeHtml(p.bestModelId)}</code>` : '',
    p.freeModels != null ? `• Model gratis: <b>${p.freeModels}</b>` : '',
    p.maxContext ? `• Konteks maksimum: ${escapeHtml(p.maxContext)}` : '',
    p.rateLimit ? `• Rate limit: ${escapeHtml(p.rateLimit)}` : '',
    p.creditCard ? `• Persyaratan: <b>${escapeHtml(p.creditCard)}</b>` : '',
    p.keyUrl ? `• Registrasi API key: <a href="${p.keyUrl}">${escapeHtml(safeHost(p.keyUrl))}</a>` : '',
  ].filter(Boolean);
  if (p.baseUrl) {
    rows.push(
      '',
      '<b>Konfigurasi (OpenAI-compatible, siap untuk router/proxy):</b>',
      `<pre>${JSON.stringify({ baseURL: p.baseUrl, apiKey: '<API_KEY_ANDA>', defaultModel: p.bestModelId ?? '<model-id>' }, null, 2)}</pre>`,
    );
  }
  return rows.join('\n');
}

function safeHost(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return u.slice(0, 60);
  }
}

export async function handleUpdateText(chatId: string, text: string): Promise<string | null> {
  const parts = text.trim().split(/\s+/);
  const cmd = (parts[0] ?? '').replace(/@oracle\S*$/i, '').toLowerCase();
  const rest = text.trim().slice(parts[0]?.length ?? 0).trim();

  if (!cmd.startsWith('/')) {
    return cmdAsk(chatId, text.trim());
  }

  switch (cmd) {
    case '/start':
    case '/help':
      return [
        '<b>ORACLE — Market &amp; AI Intelligence</b>',
        'Layanan informasi finansial, intelijen provider AI gratis, dan berita pasar secara real-time.',
        '',
        '<b>💬 Asisten AI</b>',
        '• Kirim pertanyaan apa pun secara langsung — dijawab dengan pencarian web real-time + sitasi',
        '• <code>/ask &lt;pertanyaan&gt;</code>',
        '',
        '<b>🤖 Provider AI Gratis (prioritas intelijen X)</b>',
        '• <code>/xai</code> — posting-an X tentang provider/model AI (scan langsung)',
        '• <code>/xai &lt;topik&gt;</code> — cari di X untuk topik tertentu',
        '• <code>/prov</code> — direktori provider AI gratis: base URL, jumlah model, rate limit',
        '• <code>/prov &lt;nama&gt;</code> — detail + snippet konfigurasi siap pakai',
        '• <code>/aifree</code> — model gratis OpenRouter yang dipantau',
        '• <code>/aiscan</code> — pindai menyeluruh: OpenRouter, direktori provider, X, repositori',
        '• <code>/howto</code> — SOP: cari, verifikasi, pasang provider gratis di router',
        '• <code>/airecap</code> — rekap mingguan',
        '',
        '<b>📈 Pasar &amp; Berita</b>',
        '• <code>/news</code> · <code>/newsid</code> — berita finansial global / Indonesia',
        '• <code>/price</code> — BTC/ETH/SOL, USD/IDR',
        '• <code>/digest</code> — ringkasan pagi komprehensif',
        '',
        '<b>👀 Pemantauan</b>',
        '• <code>/watch &lt;kata kunci&gt;</code> — notifikasi breaking news',
        '• <code>/unwatch</code> · <code>/watchlist</code>',
        '',
        '• <code>/status</code> — kondisi layanan',
      ].join('\n');

    case '/ask':
      return cmdAsk(chatId, rest);

    case '/howto':
      return [
        '<b>📖 SOP Menemukan & Memakai Provider AI Gratis</b>',
        '',
        '<b>1. Cari — pakai yang ORACLE pantau otomatis</b>',
        '• <code>/prov</code> — direktori 30+ provider gratis (auto-sync 2x sehari)',
        '• <code>/xai</code> — posting-an X tentang provider/model gratis baru (auto-scan per jam)',
        '• <code>/aifree</code> — model gratis di OpenRouter (baru terdeteksi = di-flag 🆕)',
        'Sumber eksternal yang gua pantau: repo awesome-freellm-apis & awesomellm-apis, OpenRouter API, X via search.',
        '',
        '<b>2. Verifikasi sendiri (2 menit, jangan percaya list buta)</b>',
        '• Cek daftar model: <code>GET {baseURL}/models</code> dengan header <code>Authorization: Bearer KEY</code>',
        '• Tes 1 completion: <code>POST {baseURL}/chat/completions</code> body <code>{"model":"...","messages":[{"role":"user","content":"OK"}]}</code>',
        '• Perhatikan: rate limit (RPM/RPD), expiry promo, dan apakah butuh kartu/HP.',
        '',
        '<b>3. Pasang di router/proxy (9router)</b>',
        '• Type: <b>OpenAI-compatible chat</b> → isi Base URL + API key dari /prov <i>nama</i>',
        '• Model ID persis dari daftar /models provider (case-sensitive)',
        '• Urutkan fallback: provider tercepat dulu; cek Usage dashboard setelah 1 hari.',
        '',
        'Lupa? Ketik <code>/help</code>.',
      ].join('\n');

    case '/xai': {
      if (rest) {
        const hits = await ddgSearch(`${rest} site:x.com`, 8);
        const posts = hits.filter((h) => /x\.com|twitter\.com/.test(h.url));
        return posts.length
          ? `<b>🐦 Intelijen X — "${escapeHtml(rest)}"</b>\n\n${xPostsText(posts)}`
          : 'Tidak ditemukan posting-an X untuk topik tersebut.';
      }
      const r = await scanX();
      const fresh = latestXPosts(10, 24 * 7);
      const newBlock = r.newPosts.length
        ? `🆕 <b>Penemuan baru (${r.newPosts.length}):</b>\n${xPostsText(r.newPosts.slice(0, 6))}`
        : 'Tidak ada posting-an baru pada pemindaian ini.';
      const hist = fresh.length
        ? `\n\n<b>7 hari terakhir (${fresh.length}):</b>\n${xPostsText(fresh.slice(0, 10))}`
        : '';
      const err = r.errors.length ? `\n<i>⚠ ${r.errors.join(' | ')}</i>` : '';
      return `<b>🐦 Intelijen X — Provider AI</b>\n\n${newBlock}${hist}${err}`;
    }

    case '/prov': {
      if (rest) {
        const p = findProvider(rest);
        return p ? provDetail(p) : `Provider "${escapeHtml(rest)}" tidak ditemukan. Ketik /prov untuk daftar lengkap.`;
      }
      let all = listProviders();
      if (all.length === 0) {
        await syncFreeLlmProviders();
        all = listProviders();
      }
      const lines = all.map(
        (p) =>
          `• <b>${escapeHtml(p.name)}</b> — ${p.freeModels ?? '?'} model gratis${p.baseUrl ? ` · <code>${escapeHtml(p.baseUrl.replace(/^https?:\/\//, ''))}</code>` : ''} · ${p.creditCard && !/^no$/i.test(p.creditCard) ? escapeHtml(p.creditCard) : 'tanpa kartu'}`,
      );
      return `<b>🧩 Direktori Provider AI Gratis (${all.length})</b>\n<i>Detail + snippet konfigurasi: /prov &lt;nama&gt;</i>\n\n${lines.join('\n')}`;
    }

    case '/news': {
      const arts = latestArticles(null, 10);
      if (!arts.length) return 'Belum ada data artikel — jalankan /scan terlebih dahulu.';
      return `<b>📰 Berita Finansial Terkini</b>\n\n${arts
        .map((a, i) => `${i + 1}. <a href="${a.url}">${escapeHtml(a.title)}</a> <i>${escapeHtml(a.source)}</i>`)
        .join('\n')}`;
    }

    case '/newsid': {
      const arts = latestArticles('indonesia', 10);
      if (!arts.length) return 'Belum ada data artikel Indonesia — jalankan /scan terlebih dahulu.';
      return `<b>🇮🇩 Berita Indonesia</b>\n\n${arts.map((a) => `• <a href="${a.url}">${escapeHtml(a.title)}</a> <i>${escapeHtml(a.source)}</i>`).join('\n')}`;
    }

    case '/price': {
      const snap = await marketSnapshot();
      const lines = formatMarketLines(snap);
      if (!lines) return `Pengambilan data gagal: ${snap.errors.join(' | ') || 'tidak diketahui'}`;
      return `<b>📊 Kondisi Pasar</b>\n\n${lines}`;
    }

    case '/digest':
      return buildMorningDigest();

    case '/aifree': {
      const all = listFreeModels(15);
      const recent = newFreeModelsSince(72, 5);
      const list = all.map((m) => `• <code>${m.id}</code> — ${m.ctx ? `${(m.ctx / 1000).toFixed(0)}k ctx` : 'n/a'}`).join('\n');
      const fresh = recent.length
        ? `\n\n<b>Baru (72 jam):</b>\n${recent.map((m) => `🆕 <code>${m.id}</code>`).join('\n')}`
        : '';
      return all.length ? `<b>🆓 Model AI Gratis Terpantau (${all.length})</b>\n${list}${fresh}` : 'Belum ada data — jalankan /aiscan.';
    }

    case '/aiscan': {
      const [r, s, x] = await Promise.all([scanAiProviders(), syncFreeLlmProviders(), scanX()]);
      const newOnes = r.newModels.length
        ? `\n🆕 <b>Model OpenRouter baru:</b>\n${r.newModels.slice(0, 8).map((m) => `• <code>${m.id}</code> (${m.ctx ? `${(m.ctx / 1000).toFixed(0)}k ctx` : 'n/a'})`).join('\n')}`
        : '';
      const provNew = s.events.length
        ? `\n🧩 <b>Perbaruan direktori provider:</b>\n${s.events.slice(0, 6).map((e) => `• ${e.type === 'new_provider' ? `BARU <b>${escapeHtml(e.name)}</b> (${e.to} model)` : `${escapeHtml(e.name)}: ${e.from} → ${e.to} model`}`).join('\n')}`
        : '';
      const xNew = x.newPosts.length ? `\n🐦 <b>Intelijen X baru (${x.newPosts.length}):</b>\n${xPostsText(x.newPosts.slice(0, 5))}` : '';
      const gh = r.ghUpdates.length
        ? `\n📦 <b>Perbaruan repositori:</b>\n${r.ghUpdates.slice(0, 4).map((u) => `• <a href="${u.url}">${escapeHtml(u.title)}</a> <i>${u.repo.split('/')[1]}</i>`).join('\n')}`
        : '';
      const errs = [...r.errors, ...x.errors, ...(s.ok ? [] : [`provider sync: ${s.error}`])];
      const err = errs.length ? `\n<i>⚠ ${errs.join(' | ')}</i>` : '';
      return `<b>Pindaian selesai.</b>\nModel gratis OpenRouter: <b>${r.freeModelsTotal}</b> · Provider terdaftar: <b>${s.total}</b>${newOnes}${provNew}${xNew}${gh}${err}`;
    }

    case '/airecap':
      return buildWeeklyAiRecap();

    case '/scan': {
      const r = await collectRss();
      const ok = r.perFeed.filter((f) => f.ok);
      const bad = r.perFeed.filter((f) => !f.ok);
      return [
        `Pemindaian RSS: <b>${ok.reduce((a, f) => a + f.items, 0)} artikel baru</b> dari ${ok.length}/${r.perFeed.length} kanal.`,
        bad.length ? `\n⚠ Gagal: ${bad.map((f) => `${escapeHtml(f.source)} (${escapeHtml(f.error ?? '')})`).join(', ')}` : '',
      ].join('');
    }

    case '/status': {
      const counts = {
        articles: (db.prepare('SELECT COUNT(*) c FROM articles').get() as { c: number }).c,
        lastRss: kvGet('last_rss_scan') ?? null,
        lastAi: kvGet('last_ai_scan') ?? null,
        lastProv: kvGet('last_prov_sync') ?? null,
        lastXai: kvGet('last_xai_scan') ?? null,
        providers: (db.prepare('SELECT COUNT(*) c FROM ai_providers').get() as { c: number }).c,
        freeModels: (db.prepare("SELECT COUNT(*) c FROM ai_models WHERE provider='openrouter'").get() as { c: number }).c,
        xPosts: (db.prepare('SELECT COUNT(*) c FROM x_posts').get() as { c: number }).c,
        watches: (db.prepare('SELECT COUNT(*) c FROM watch').get() as { c: number }).c,
      };
      const since = (iso: string | null): string => (iso ? new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' }) : '—');
      return [
        '<b>⚙️ Status Layanan ORACLE</b>',
        `• Artikel tersimpan: <b>${counts.articles}</b> · Sinkron RSS terakhir: ${since(counts.lastRss)}`,
        `• Provider AI: <b>${counts.providers}</b> · Model gratis OpenRouter: <b>${counts.freeModels}</b> · Intelijen X: <b>${counts.xPosts}</b> (terbaru: ${since(counts.lastXai)})`,
        `• Sinkron direktori provider: ${since(counts.lastProv)} · Pindai OpenRouter: ${since(counts.lastAi)}`,
        `• Kata kunci pemantauan: <b>${counts.watches}</b>`,
        `• Rantai LLM: ${config.llmChain.map((p) => escapeHtml(p.name)).join(' → ')}`,
        `• Waktu server: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`,
      ].join('\n');
    }

    case '/watch': {
      if (!rest) return 'Gunakan format: <code>/watch &lt;kata kunci&gt;</code>';
      try {
        db.prepare('INSERT INTO watch(keyword, created_at) VALUES(?, ?)').run(rest.toLowerCase(), new Date().toISOString());
        return `✓ Pemantauan aktif untuk <code>${escapeHtml(rest)}</code>. Notifikasi dikirim saat ada berita relevan.`;
      } catch {
        return `Kata kunci <code>${escapeHtml(rest)}</code> sudah dipantau.`;
      }
    }

    case '/unwatch': {
      if (!rest) return 'Gunakan format: <code>/unwatch &lt;kata kunci&gt;</code>';
      const res = db.prepare('DELETE FROM watch WHERE keyword = ?').run(rest.toLowerCase());
      return res.changes > 0 ? `✓ Pemantauan <code>${escapeHtml(rest)}</code> dihapus.` : `Kata kunci <code>${escapeHtml(rest)}</code> tidak ditemukan di watchlist.`;
    }

    case '/watchlist': {
      const rows = db.prepare('SELECT keyword FROM watch ORDER BY keyword').all() as { keyword: string }[];
      return rows.length
        ? `<b>👀 Watchlist</b>\n${rows.map((r) => `• <code>${escapeHtml(r.keyword)}</code>`).join('\n')}`
        : 'Watchlist kosong. Tambahkan dengan /watch <i>kata kunci</i>.';
    }

    default:
      return null;
  }
}
