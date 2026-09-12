import { config } from '../config.js';
import { assertLlm } from '../config.js';
import { escapeHtml } from '../util.js';
import { llmChat } from '../llm.js';
import { ddgSearch } from '../search.js';
import { db, kvGet, remember, recentHistory } from '../db.js';
import { latestArticles, collectRss } from '../collectors/rss.js';
import { scanAiProviders, listFreeModels, newFreeModelsSince } from '../collectors/ai.js';
import { syncFreeLlmProviders, listProviders, findProvider, type ProviderRow } from '../collectors/freellm.js';
import { runIntelScan, latestIntel } from '../collectors/intel.js';
import { xSessionStatus } from '../collectors/xauth.js';
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
    const xPosts = latestIntel(8, 24 * 7).map((p) => `[${p.source}] ${p.title}`).join('\n');
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

/** Nomorin temuan per sesi → user vote: /fb 2 + / - */
function intelNumbered(items: { hash: string; title: string; url: string; snippet: string; source: string }[], offset = 0): { text: string; map: Map<number, string> } {
  const map = new Map<number, string>();
  const lines = items.slice(0, 8).map((p, i) => {
    const n = offset + i + 1;
    map.set(n, p.hash);
    return `<b>${n}.</b> <a href="${p.url}">${escapeHtml(p.title.slice(0, 90))}</a> <i>${escapeHtml(p.source)}</i>${p.snippet ? `\n  ${escapeHtml(p.snippet.slice(0, 130))}` : ''}`;
  });
  return { text: lines.join('\n'), map };
}

const lastIntel = new Map<string, { map: Map<number, string>; ttl: number }>();
function setIntelMap(chatId: string, map: Map<number, string>): void {
  lastIntel.set(chatId, { map, ttl: Date.now() + 3600_000 });
}
function getIntelMap(chatId: string): Map<number, string> | undefined {
  const e = lastIntel.get(chatId);
  if (!e) return undefined;
  if (e.ttl < Date.now()) {
    lastIntel.delete(chatId);
    return undefined;
  }
  return e.map;
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
        '<b>🤖 Provider AI Gratis (prioritas intelijen)</b>',
        '• <code>/freeai</code> — <b>briefing lengkap semua free-AI</b> (direktori + model + X + intelijen)',
        '• <code>/intel</code> — pemindaian semua sumber: perubahan provider (diff /models), Google News, Reddit, HN, X',
        '• <code>/intel</code> (alias /xai) — perubahan & temuan baru, auto-push tiap temuan',
        '• <code>/prov</code> — direktori provider AI gratis: base URL, jumlah model, rate limit',
        '• <code>/prov &lt;nama&gt;</code> — detail + snippet konfigurasi siap pakai',
        '• <code>/aifree</code> — model gratis OpenRouter yang dipantau',
        '• <code>/aiscan</code> — pindai menyeluruh: OpenRouter, direktori provider, X, repositori',
        '• <code>/learn</code> — riwayat pembelajaran bot: feedback, query dipelajari, kesehatan sumber',
        '• <code>/fb &lt;nomor&gt; +|-</code> — nilai kualitas temuan /intel (bot belajar)',
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
        '• <code>/watchprice btc above 100000</code> — peringatan harga (btc/eth/sol/usdidr)',
        '• <code>/unwatch</code> · <code>/unwatchprice</code> · <code>/watchlist</code>',
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

    case '/freeai': {
      let provAll = listProviders();
      if (provAll.length === 0) {
        await syncFreeLlmProviders();
        provAll = listProviders();
      }
      const models = listFreeModels(12);
      const intelAll = latestIntel(10, 48);
      const xLive = intelAll.filter((i) => i.source === 'X (live)');
      const intelRecent = latestIntel(8, 24);
      const xStatus = xSessionStatus();

      const parts: string[] = ['<b>🆓 Free AI — Briefing Lengkap</b>', ''];

      parts.push(
        `<b>1. Provider direktori (${provAll.length})</b> — 10 teratas:` +
          '\n' +
          provAll
            .slice(0, 10)
            .map((p) => `• <b>${escapeHtml(p.name)}</b> — ${p.freeModels ?? '?'} model${p.creditCard && !/^no$/i.test(p.creditCard) ? ` · ${escapeHtml(p.creditCard)}` : ' · tanpa kartu'}${p.baseUrl ? ` · <code>${escapeHtml(p.baseUrl.replace(/^https?:\/\//, ''))}</code>` : ''}`)
            .join('\n') +
          `\n<i>Lengkap + config snippet: /prov — detail: /prov nama</i>`,
      );

      parts.push(
        `\n<b>2. Model gratis OpenRouter terpantau (${models.length} terakhir)</b>\n` +
          models.map((m) => `• <code>${m.id}</code> — ${m.ctx ? `${(m.ctx / 1000).toFixed(0)}k ctx` : 'n/a'}`).join('\n'),
      );

      parts.push(
        `\n<b>3. X live ${xStatus.live ? '✅' : '⚠️ (session mati)'}</b>\n` +
          (xLive.length
            ? xLive.map((p) => `• <a href="${p.url}">${escapeHtml(p.title.slice(0, 90))}</a> <i>${escapeHtml(p.origin ?? '')}</i>`).join('\n')
            : 'Tidak ada posting-an baru 48 jam terakhir.'),
      );

      parts.push(
        `\n<b>4. Intelijen lainnya (24 jam)</b>\n` +
          (intelRecent.length
            ? intelRecent.slice(0, 6).map((p) => `• <a href="${p.url}">${escapeHtml(p.title.slice(0, 90))}</a> <i>${escapeHtml(p.source)}</i>`).join('\n')
            : 'Tidak ada temuan baru.'),
      );

      parts.push(
        `\n<i>Scan manual penuh: /intel · /aiscan · Direktori: /prov · SOP pasang: /howto</i>`,
      );
      return parts.join('\n');
    }

    case '/xai':
    case '/intel': {
      if (rest) {
        const hits = await ddgSearch(`${rest} site:x.com OR site:reddit.com OR site:news.ycombinator.com`, 8);
        const posts = hits.filter((h) => /x\.com|twitter\.com|reddit\.com|news\.ycombinator\.com/.test(h.url));
        return posts.length
          ? `<b>🔎 Intelijen — "${escapeHtml(rest)}"</b>\n\n${xPostsText(posts)}`
          : 'Tidak ditemukan untuk topik tersebut.';
      }
      const r = await runIntelScan();
      const parts: string[] = ['<b>🛰 Intelijen Free-AI Provider</b>'];
      if (r.alerts.length) {
        parts.push(`\n<b>⚠ Perubahan terdeteksi:</b>\n${r.alerts.slice(0, 8).join('\n')}`);
      }
      const numbered = intelNumbered(r.newItems, 0);
      setIntelMap(chatId, numbered.map);
      if (r.newItems.length) {
        const bySrc: Record<string, typeof r.newItems> = {};
        for (const it of r.newItems) (bySrc[it.source] ??= []).push(it);
        const blocks = Object.entries(bySrc).map(([src, items]) => `<b>${src}:</b>\n${xPostsText(items.slice(0, 5))}`);
        parts.push(`\n${blocks.join('\n\n')}`);
        parts.push(`\n<i>👉 Nilai kualitas hasil: /fb &lt;nomor&gt; + (relevan) atau - (noise) — bot belajar dari vote lu.</i>`);
        parts.push(`\n<b>Daftar bernomor:</b>\n${numbered.text}`);
      } else {
        parts.push('\nTidak ada temuan baru — semua sumber sudah terpindai sebelumnya.');
      }
      const perSrc = Object.entries(r.perSource).map(([s, n]) => `${s}:${n}`).join(', ');
      if (perSrc) parts.push(`\n<i>${perSrc}</i>`);
      if (r.errors.length) parts.push(`\n<i>⚠ ${r.errors.join(' | ')}</i>`);
      return parts.join('\n');
    }

    case '/fb': {
      const m = rest.match(/^(\d+)\s*([+-])$/);
      if (!m) return 'Gunakan: <code>/fb &lt;nomor&gt; +</code> atau <code>/fb &lt;nomor&gt; -</code> — nomor dari daftar /intel terakhir (umur 1 jam).';
      let map = getIntelMap(chatId);
      if (!map) {
        // fallback: pakai temuan terbaru (48 jam) biar vote tetap bisa jalan
        const recent = latestIntel(8, 48);
        map = new Map(recent.map((it, i) => [i + 1, it.hash]));
      }
      const n = Number(m[1]);
      const hash = map?.get(n);
      if (!hash) return 'Nomor tidak dikenal. Jalankan /intel lalu vote dengan nomor dari daftar.';
      const vote = m[2] === '+' ? 1 : -1;
      const { recordFeedback } = await import('../learning.js');
      recordFeedback(hash, vote as 1 | -1, chatId);
      const item = db.prepare('SELECT title, score FROM intel_items WHERE hash = ?').get(hash) as { title: string; score: number } | undefined;
      const voteText = vote > 0 ? '✅ Relevan' : '🗑 Noise';
      const learnNote =
        vote < 0
          ? '\n<i>Bot akan turunkan bobot temuan serupa &amp; cooldown sumber kalau konsisten jelek.</i>'
          : '\n<i>Bot akan promosikan query terkait ke pemindaian rutin.</i>';
      if (vote > 0 && item) {
        const { learnQuery } = await import('../learning.js');
        learnQuery(item.title.slice(0, 100), 'user-feedback');
      }
      return `${voteText} — <i>${escapeHtml(item?.title.slice(0, 80) ?? '')}</i> (skor: ${item?.score ?? 0})${learnNote}`;
    }

    case '/learn': {
      const { learningDigest } = await import('../learning.js');
      const rows = db
        .prepare('SELECT COUNT(*) c, SUM(CASE WHEN vote>0 THEN 1 ELSE 0 END) up, SUM(CASE WHEN vote<0 THEN 1 ELSE 0 END) down FROM feedback')
        .get() as { c: number; up: number | null; down: number | null };
      const q = db.prepare('SELECT COUNT(*) c FROM learned_queries WHERE active = 1').get() as { c: number };
      const health = db.prepare('SELECT source, dead_until, last_error FROM source_health WHERE dead_until IS NOT NULL AND dead_until > ?').all(new Date().toISOString()) as { source: string; dead_until: string; last_error: string }[];
      const lines = learningDigest();
      return [
        '<b>🧠 Pembelajaran Bot</b>',
        `• Feedback diterima: <b>${rows.c}</b> (👍 ${rows.up ?? 0} · 👎 ${rows.down ?? 0})`,
        `• Query dipelajari &amp; aktif: <b>${q.c}</b>`,
        health.length ? `\n<b>Sumber di-cooldown:</b>\n${health.map((h) => `• ${escapeHtml(h.source)} — ${escapeHtml(h.last_error ?? '')}`).join('\n')}` : '\nSemua sumber sehat ✅',
        lines.length ? `\n<b>Aktivitas belajar terakhir:</b>\n${lines.join('\n')}` : '',
      ].join('\n');
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
      const [r, s, x] = await Promise.all([scanAiProviders(), syncFreeLlmProviders(), runIntelScan()]);
      const newOnes = r.newModels.length
        ? `\n🆕 <b>Model OpenRouter baru:</b>\n${r.newModels.slice(0, 8).map((m) => `• <code>${m.id}</code> (${m.ctx ? `${(m.ctx / 1000).toFixed(0)}k ctx` : 'n/a'})`).join('\n')}`
        : '';
      const provNew = s.events.length
        ? `\n🧩 <b>Perbaruan direktori provider:</b>\n${s.events.slice(0, 6).map((e) => `• ${e.type === 'new_provider' ? `BARU <b>${escapeHtml(e.name)}</b> (${e.to} model)` : `${escapeHtml(e.name)}: ${e.from} → ${e.to} model`}`).join('\n')}`
        : '';
      const xNew = x.alerts.length
        ? `\n🛰 <b>Perubahan provider terdeteksi:</b>\n${x.alerts.slice(0, 6).join('\n')}`
        : x.newItems.length
          ? `\n🛰 <b>Intelijen baru (${x.newItems.length}):</b>\n${xPostsText(x.newItems.slice(0, 5))}`
          : '';
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

    case '/watchprice': {
      const m = rest.match(/^(btc|eth|sol|usdidr)\s+(above|below)\s+([\d.,]+)$/i);
      if (!m) return 'Format: <code>/watchprice btc above 100000</code> · target: btc/eth/sol/usdidr · operator: above/below';
      const { addPriceWatch } = await import('../collectors/watchprice.js');
      return addPriceWatch(m[1], m[2].toLowerCase(), Number(m[3].replace(/,/g, '')));
    }

    case '/unwatchprice': {
      if (!rest) return 'Format: <code>/unwatchprice btc</code>';
      const { removePriceWatch } = await import('../collectors/watchprice.js');
      return removePriceWatch(rest);
    }

    case '/watchlist': {
      const rows = db.prepare('SELECT keyword FROM watch ORDER BY keyword').all() as { keyword: string }[];
      const { listPriceWatches } = await import('../collectors/watchprice.js');
      const kw = rows.length ? `• <b>Kata kunci berita</b>\n${rows.map((r) => `• <code>${escapeHtml(r.keyword)}</code>`).join('\n')}` : '';
      const pw = listPriceWatches();
      return [`<b>👀 Daftar Pemantauan</b>`, kw, kw ? '' : '', pw].filter(Boolean).join('\n');
    }

    default:
      return null;
  }
}
