import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { ddgSearch } from '../search.js';

const X_QUERIES = [
  'site:x.com free LLM API provider base_url',
  'site:x.com free AI API model gratis developers',
  'site:x.com OpenRouter free model baru',
  'site:x.com Groq OR Cerebras OR SambaNova free tier',
  'site:x.com "free" AI API key limits context',
];

export interface XPost {
  hash: string;
  title: string;
  url: string;
  snippet: string;
  query: string;
}

const isX = (url: string) => /https?:\/\/(www\.)?(x|twitter)\.com\//.test(url);

export async function scanX(): Promise<{ newPosts: XPost[]; errors: string[] }> {
  const results = await Promise.allSettled(X_QUERIES.map((q) => ddgSearch(q, 8)));
  const errors: string[] = [];
  const seen = new Set<string>();
  const candidates: XPost[] = [];

  results.forEach((res, i) => {
    if (res.status === 'rejected') {
      errors.push(`q${i}: ${String((res.reason as Error)?.message ?? res.reason)}`);
      return;
    }
    for (const h of res.value) {
      if (!isX(h.url)) continue;
      const hash = createHash('sha1').update(h.url).digest('hex');
      if (seen.has(hash)) continue;
      seen.add(hash);
      candidates.push({ hash, title: h.title, url: h.url, snippet: h.snippet, query: X_QUERIES[i] });
    }
  });

  const insert = db.prepare('INSERT OR IGNORE INTO x_posts(hash, title, url, snippet, query, found_at) VALUES(?,?,?,?,?,?)');
  const newPosts: XPost[] = [];
  for (const p of candidates) {
    const r = insert.run(p.hash, p.title, p.url, p.snippet, p.query, new Date().toISOString());
    if (r.changes > 0) newPosts.push(p);
  }
  return { newPosts, errors };
}

export function latestXPosts(limit = 10, hours = 168): { title: string; url: string; snippet: string; foundAt: string }[] {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = db
    .prepare('SELECT title, url, snippet, found_at FROM x_posts WHERE found_at >= ? ORDER BY found_at DESC LIMIT ?')
    .all(since, limit) as { title: string; url: string; snippet: string; found_at: string }[];
  return rows.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, foundAt: r.found_at }));
}
