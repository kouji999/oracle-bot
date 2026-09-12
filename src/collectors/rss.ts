import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { db, kvSet } from '../db.js';
import { decodeEntities, escapeHtml } from '../util.js';

export interface FeedDef {
  source: string;
  category: 'global' | 'indonesia' | 'crypto';
  url: string;
}

export const FEEDS: FeedDef[] = [
  { source: 'Yahoo Finance', category: 'global', url: 'https://finance.yahoo.com/news/rssindex' },
  { source: 'CNBC Markets', category: 'global', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258' },
  { source: 'MarketWatch', category: 'global', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { source: 'Google News ID', category: 'indonesia', url: 'https://news.google.com/rss/search?q=IHSG+OR+ekonomi+OR+saham&hl=id&gl=ID&ceid=ID:id' },
  { source: 'CNBC Indonesia', category: 'indonesia', url: 'https://www.cnbcindonesia.com/rss' },
  { source: 'Bloomberg Tech', category: 'global', url: 'https://feeds.bloomberg.com/technology/news.rss' },
  { source: 'CoinTelegraph', category: 'crypto', url: 'https://cointelegraph.com/rss' },
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

interface RawItem {
  title?: unknown;
  link?: unknown;
  pubDate?: unknown;
  published?: unknown;
  updated?: unknown;
  description?: unknown;
  summary?: unknown;
  content?: unknown;
  '@_href'?: unknown;
}

export interface CollectedArticle {
  hash: string;
  source: string;
  category: string;
  title: string;
  url: string;
  summary: string;
  publishedAt: string | null;
}

function pickString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o['#text'] === 'string') return o['#text'];
    if (typeof o['@_href'] === 'string') return o['@_href'];
  }
  return '';
}

function stripHtml(s: string): string {
  return decodeEntities(
    s
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

export async function fetchFeed(feed: FeedDef): Promise<RawItem[]> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(feed.url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; ORACLE-Bot/0.1; +https://t.me/oracle)',
        accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    const j = parser.parse(text) as Record<string, unknown>;
    const rss = j.rss as { channel?: { item?: RawItem | RawItem[] } } | undefined;
    const atom = j.feed as { entry?: RawItem | RawItem[] } | undefined;
    const rdf = j['rdf:RDF'] as { item?: RawItem | RawItem[] } | undefined;
    const raw: RawItem | RawItem[] | undefined = rss?.channel?.item ?? atom?.entry ?? rdf?.item ?? undefined;
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
  } finally {
    clearTimeout(to);
  }
}

function normalizeItem(item: RawItem, feed: FeedDef): CollectedArticle | null {
  const title = stripHtml(pickString(item.title));
  let url = pickString(item.link);
  if (!url && item['@_href']) url = String(item['@_href']);
  if (!title || !url.startsWith('http')) return null;
  const pubRaw = pickString(item.pubDate) || pickString(item.published) || pickString(item.updated);
  let publishedAt: string | null = null;
  if (pubRaw) {
    const d = new Date(pubRaw);
    if (!isNaN(d.getTime())) publishedAt = d.toISOString();
  }
  const summary = stripHtml(pickString(item.description) || pickString(item.summary) || pickString(item.content)).slice(0, 500);
  return {
    hash: createHash('sha1').update(url).digest('hex'),
    source: feed.source,
    category: feed.category,
    title,
    url,
    summary,
    publishedAt,
  };
}

export interface RssResult {
  perFeed: { source: string; ok: boolean; items: number; error?: string }[];
  newArticles: CollectedArticle[];
}

export async function collectRss(): Promise<RssResult> {
  const perFeed: RssResult['perFeed'] = [];
  const newArticles: CollectedArticle[] = [];
  const results = await Promise.allSettled(FEEDS.map((f) => fetchFeed(f)));
  results.forEach((res, i) => {
    const feed = FEEDS[i];
    if (res.status === 'fulfilled') {
      let inserted = 0;
      for (const raw of res.value) {
        const art = normalizeItem(raw, feed);
        if (!art) continue;
        const r = db
          .prepare(
            'INSERT OR IGNORE INTO articles(hash, source, category, title, url, summary, published_at, collected_at) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(art.hash, art.source, art.category, art.title, art.url, art.summary, art.publishedAt, new Date().toISOString());
        if (r.changes > 0) {
          inserted++;
          newArticles.push(art);
        }
      }
      perFeed.push({ source: feed.source, ok: true, items: inserted });
    } else {
      perFeed.push({ source: feed.source, ok: false, items: 0, error: String((res.reason as Error)?.message ?? res.reason) });
    }
  });
  kvSet('last_rss_scan', new Date().toISOString());
  return { perFeed, newArticles };
}

export function latestArticles(category: string | null, limit = 8): CollectedArticle[] {
  const rows = (
    category
      ? db.prepare('SELECT * FROM articles WHERE category = ? ORDER BY COALESCE(published_at, collected_at) DESC LIMIT ?').all(category, limit)
      : db.prepare('SELECT * FROM articles ORDER BY COALESCE(published_at, collected_at) DESC LIMIT ?').all(limit)
  ) as Record<string, unknown>[];
  return rows.map((r) => ({
    hash: String(r.hash),
    source: String(r.source),
    category: String(r.category),
    title: String(r.title),
    url: String(r.url),
    summary: String(r.summary ?? ''),
    publishedAt: r.published_at ? String(r.published_at) : null,
  }));
}

export function articlesSince(hours: number, category?: string, limit = 20): CollectedArticle[] {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = (
    category
      ? db.prepare("SELECT * FROM articles WHERE COALESCE(published_at, collected_at) >= ? AND category = ? ORDER BY COALESCE(published_at, collected_at) DESC LIMIT ?").all(since, category, limit)
      : db.prepare('SELECT * FROM articles WHERE COALESCE(published_at, collected_at) >= ? ORDER BY COALESCE(published_at, collected_at) DESC LIMIT ?').all(since, limit)
  ) as Record<string, unknown>[];
  return rows.map((r) => ({
    hash: String(r.hash),
    source: String(r.source),
    category: String(r.category),
    title: String(r.title),
    url: String(r.url),
    summary: String(r.summary ?? ''),
    publishedAt: r.published_at ? String(r.published_at) : null,
  }));
}
