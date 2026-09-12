import { createHash } from 'node:crypto';
import { db, kvSet } from '../db.js';
import { config } from '../config.js';
import { ddgSearch } from '../search.js';

/**
 * intel.ts — free-AI-provider intelligence engine.
 * Sumber (urut prioritas):
 *  1. Google News RSS (index real-time, termasuk post X yang viral) — no key
 *  2. Reddit JSON (r/LocalLLaMA, AI subs) — tempat deal free API dibicarakan
 *  3. Hacker News Algolia — rilis project AI
 *  4. Provider watch: diff /models provider yang key-nya kita pegang (tokenrouter, b.ai)
 *  5. OpenRouter diff: free/paid transition + model baru
 *  6. Nitter RSS (mirror X) — multi-instance failover
 *  7. DDG site:x.com (lapis terakhir)
 */

export interface IntelItem {
  hash: string;
  source: string;
  origin: string | null;
  title: string;
  url: string;
  snippet: string;
}

const GOOGLE_NEWS_QUERIES = [
  '"free" AI API provider model',
  '"OpenRouter" free model',
  'LLM API gratis free tier',
];

const REDDIT_URLS = [
  { sub: 'r/LocalLLaMA', url: 'https://www.reddit.com/r/LocalLLaMA/new.json?limit=25' },
  { sub: 'r/ArtificialInteligence', url: 'https://www.reddit.com/r/ArtificialInteligence/new.json?limit=15' },
  { sub: 'r/OpenAI', url: 'https://www.reddit.com/r/OpenAI/new.json?limit=15' },
];

const HN_ALGOLIA = 'https://hn.algolia.com/api/v1/search_by_date?query="free" LLM API&tags=story&hitsPerPage=15';

const NITTER_INSTANCES = [
  'https://nitter.net',
  'https://nitter.poast.org',
  'https://nitter.privacyredirect.com',
];
const NITTER_FEEDS = ['OpenRouter', 'alienaskets'];

const FREE_SIGNAL_RE = /\b(free|gratis|free tier|no cost|zero cost|open weights|promo|credit)\b/i;
const AI_PROVIDER_RE = /\b(llm|api|model|provider|openrouter|groq|gemini|glm|qwen|deepseek|kimi|minimax|tokenrouter|b\.ai|cerebras|sambanova|mistral|nim|ollama)\b/i;

function hashOf(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

function matches(q: string): boolean {
  return FREE_SIGNAL_RE.test(q) && AI_PROVIDER_RE.test(q);
}

async function fetchText(url: string, headers: Record<string, string> = {}, timeoutMs = 20_000): Promise<string> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(to);
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function parseAtomOrRss(xml: string, baseUrl: string): { title: string; url: string; origin: string | null }[] {
  const out: { title: string; url: string; origin: string | null }[] = [];
  // RSS <item>
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = tag(block, 'title');
    let url2 = tag(block, 'link');
    if (!url2) {
      const dm = block.match(/<guid[^>]*>([^<]+)<\/guid>/);
      url2 = dm ? dm[1].trim() : '';
    }
    if (title && url2) out.push({ title: decodeXml(title), url: url2.startsWith('http') ? url2 : baseUrl + url2, origin: baseUrl });
  }
  // Atom <entry>
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const title = tag(block, 'title');
    const lm = block.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/);
    const url2 = lm ? lm[1] : '';
    if (title && url2) out.push({ title: decodeXml(title), url: url2, origin: baseUrl });
  }
  return out;
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : '';
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .trim();
}

async function collectGoogleNews(): Promise<IntelItem[]> {
  const items: IntelItem[] = [];
  for (const q of GOOGLE_NEWS_QUERIES) {
    try {
      const xml = await fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`);
      for (const p of parseAtomOrRss(xml, 'news.google.com')) {
        if (!matches(p.title)) continue;
        items.push({ hash: hashOf(p.url), source: 'Google News', origin: p.origin, title: p.title, url: p.url, snippet: '' });
      }
    } catch { /* skip */ }
  }
  return items;
}

async function collectReddit(): Promise<IntelItem[]> {
  const items: IntelItem[] = [];
  for (const { sub, url } of REDDIT_URLS) {
    try {
      const raw = await fetchText(url);
      const j = JSON.parse(raw) as { data?: { children?: { data?: { title?: string; url?: string; selftext?: string; permalink?: string } }[] } };
      for (const c of j.data?.children ?? []) {
        const d = c.data;
        if (!d?.title || !d?.permalink) continue;
        const fullUrl = 'https://www.reddit.com' + d.permalink;
        if (!matches(d.title + ' ' + (d.selftext ?? ''))) continue;
        items.push({ hash: hashOf(fullUrl), source: 'Reddit', origin: sub, title: d.title, url: fullUrl, snippet: (d.selftext ?? '').slice(0, 200) });
      }
    } catch { /* skip */ }
  }
  return items;
}

async function collectHn(): Promise<IntelItem[]> {
  const items: IntelItem[] = [];
  try {
    const raw = await fetchText(HN_ALGOLIA);
    const j = JSON.parse(raw) as { hits?: { title?: string; url?: string; objectID?: string; story_text?: string }[] };
    for (const h of j.hits ?? []) {
      if (!h.title) continue;
      const u = h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`;
      if (!matches(h.title + ' ' + (h.story_text ?? ''))) continue;
      items.push({ hash: hashOf(u), source: 'Hacker News', origin: 'hn.algolia', title: h.title, url: u, snippet: '' });
    }
  } catch { /* skip */ }
  return items;
}

async function collectNitter(): Promise<IntelItem[]> {
  const items: IntelItem[] = [];
  for (const inst of NITTER_INSTANCES) {
    let ok = 0;
    for (const user of NITTER_FEEDS) {
      try {
        const xml = await fetchText(`${inst}/${user}/rss`);
        for (const p of parseAtomOrRss(xml, inst)) {
          if (!matches(p.title)) continue;
          items.push({ hash: hashOf(p.url), source: 'X (nitter)', origin: `@${user}`, title: p.title, url: p.url, snippet: '' });
          ok++;
        }
      } catch { /* next feed */ }
    }
    if (ok > 0) break; // instance pertama yang hidup cukup
  }
  return items;
}

interface WatchProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
}

/** Diff /models provider yang kita pegang key-nya (tokenrouter, b.ai) + OpenRouter public. */
async function collectProviderDiffs(): Promise<{ alerts: string[]; errors: string[] }> {
  const alerts: string[] = [];
  const errors: string[] = [];

  const watched: WatchProvider[] = config.llmChain
    .filter((p) => p.name !== 'devstack')
    .map((p) => ({ name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey }));

  const now = new Date().toISOString();
  const insert = db.prepare('INSERT OR IGNORE INTO ai_models(provider, model_id, name, ctx, first_seen) VALUES(?,?,?,?,?)');
  const drop = db.prepare('DELETE FROM ai_models WHERE provider = ? AND model_id = ?');

  for (const p of watched) {
    try {
      const raw = await fetchText(`${p.baseUrl}/models`, { authorization: `Bearer ${p.apiKey}` });
      const j = JSON.parse(raw) as { data?: { id: string; context_length?: number }[] };
      const ids = (j.data ?? []).map((m) => m.id);
      const known = new Set((db.prepare('SELECT model_id FROM ai_models WHERE provider = ?').all(p.name) as { model_id: string }[]).map((r) => r.model_id));
      let added = 0;
      for (const m of j.data ?? []) {
        if (!known.has(m.id)) {
          const isFree = /free|flash$|:free/i.test(m.id) || p.name === 'tokenrouter';
          if (isFree || known.size === 0) {
            insert.run(p.name, m.id, m.id, m.context_length ?? null, now);
            if (known.size > 0) {
              alerts.push(`🆕 <b>${p.name}</b> menambahkan model: <code>${m.id}</code>${m.context_length ? ` (${Math.round(m.context_length / 1000)}k ctx)` : ''}`);
              added++;
            }
          }
        }
      }
      // deteksi model hilang (misal promo free dicabut)
      const current = new Set(ids);
      for (const id of known) {
        if (!current.has(id)) {
          drop.run(p.name, id);
          alerts.push(`⚠ <b>${p.name}</b> mencabut model: <code>${id}</code>`);
        }
      }
    } catch (e) {
      errors.push(`${p.name}: ${(e as Error).message}`);
    }
  }

  // OpenRouter public: free/paid transition
  try {
    const raw = await fetchText('https://openrouter.ai/api/v1/models');
    const j = JSON.parse(raw) as { data?: { id: string; name?: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }[] };
    const freeSet = new Set((j.data ?? []).filter((m) => m.pricing?.prompt === '0' && m.pricing?.completion === '0').map((m) => m.id));
    const prevFree = new Set((db.prepare("SELECT model_id FROM ai_models WHERE provider = 'openrouter'").all() as { model_id: string }[]).map((r) => r.model_id));
    for (const id of freeSet) {
      if (!prevFree.has(id)) {
        const m = (j.data ?? []).find((x) => x.id === id);
        insert.run('openrouter', id, m?.name ?? id, m?.context_length ?? null, now);
        alerts.push(`🆕 OpenRouter <b>BARU GRATIS</b>: <code>${id}</code>${m?.context_length ? ` (${Math.round(m.context_length / 1000)}k ctx)` : ''}`);
      }
    }
    for (const id of prevFree) {
      if (!freeSet.has(id)) {
        drop.run('openrouter', id);
        alerts.push(`⚠ OpenRouter model <b>tidak lagi gratis</b>: <code>${id}</code>`);
      }
    }
  } catch (e) {
    errors.push(`openrouter: ${(e as Error).message}`);
  }

  kvSet('last_intel_scan', now);
  return { alerts, errors };
}

export interface IntelResult {
  newItems: IntelItem[];
  alerts: string[];
  errors: string[];
  perSource: Record<string, number>;
}

export async function runIntelScan(): Promise<IntelResult> {
  const [alertsRes, gnews, reddit, hn, nitter] = await Promise.all([
    collectProviderDiffs(),
    collectGoogleNews().catch(() => [] as IntelItem[]),
    collectReddit().catch(() => [] as IntelItem[]),
    collectHn().catch(() => [] as IntelItem[]),
    collectNitter().catch(() => [] as IntelItem[]),
  ]);

  const ddgX = await ddgSearch('site:x.com free AI API provider model', 8)
    .then((h) => h.filter((x) => /x\.com|twitter\.com/.test(x.url)).map((x) => ({ hash: hashOf(x.url), source: 'X (search)', origin: 'x.com', title: x.title, url: x.url, snippet: x.snippet.slice(0, 200) })))
    .catch(() => [] as IntelItem[]);

  const all = [...gnews, ...reddit, ...hn, ...nitter, ...ddgX];
  const insert = db.prepare('INSERT OR IGNORE INTO intel_items(hash, source, origin, title, url, snippet, found_at) VALUES(?,?,?,?,?,?,?)');
  const newItems: IntelItem[] = [];
  const perSource: Record<string, number> = {};
  for (const it of all) {
    const r = insert.run(it.hash, it.source, it.origin, it.title, it.url, it.snippet, new Date().toISOString());
    if (r.changes > 0) {
      newItems.push(it);
      perSource[it.source] = (perSource[it.source] ?? 0) + 1;
    }
  }

  kvSet('last_intel_scan', new Date().toISOString());
  return { newItems, alerts: alertsRes.alerts, errors: alertsRes.errors, perSource };
}

export function latestIntel(limit = 12, hours = 24 * 14): IntelItem[] {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = db
    .prepare('SELECT * FROM intel_items WHERE found_at >= ? ORDER BY found_at DESC LIMIT ?')
    .all(since, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    hash: String(r.hash),
    source: String(r.source),
    origin: r.origin ? String(r.origin) : null,
    title: String(r.title),
    url: String(r.url),
    snippet: String(r.snippet ?? ''),
  }));
}
