import { db } from './db.js';

/**
 * learning.ts — self-improvement loop.
 * - Feedback user (👍/👎 di /intel terbaru) → reweight query & banlist noise
 * - Query bank: DDG queries dinamis (dipromosikan/diturunkan berdasarkan hasil)
 * - Signal drift: 3x temuan "gratis X" dari sumber beda → auto-watch keyword
 */

export interface FeedbackSignal {
  queryFrag?: string;
  source: string;
  vote: number;
}

const NOISE_PATTERNS: RegExp[] = [
  /\b(youcam|beauty|cosmetic|skincare|perfect corp)\b/i,
  /\b(casino|judi|slot gacor|togel)\b/i,
  /\b(coupon|voucher|giveaway winner|discount code)\b/i,
];

export function isNoise(title: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(title));
}

/** Catat feedback; hitung apakah query-fragment layak dipromosikan / sumber perlu ditegur. */
export function recordFeedback(itemHash: string, vote: 1 | -1, chatId: string): void {
  const item = db.prepare('SELECT source, origin, title, query FROM intel_items WHERE hash = ?').get(itemHash) as
    | { source: string; origin: string | null; title: string; query: string | null }
    | undefined;
  if (!item) return;
  db.prepare('INSERT INTO feedback(item_hash, vote, chat_id, created_at) VALUES(?,?,?,?)').run(itemHash, vote, chatId, new Date().toISOString());
  db.prepare('UPDATE intel_items SET score = score + ? WHERE hash = ?').run(vote, itemHash);

  const src = item.source;
  const recent = db
    .prepare('SELECT AVG(vote) v FROM feedback WHERE created_at >= ?').get(new Date(Date.now() - 7 * 86400_000).toISOString()) as { v: number | null };
  const srcRecent = db
    .prepare('SELECT AVG(vote) v, COUNT(*) c FROM feedback f JOIN intel_items i ON i.hash = f.item_hash WHERE i.source = ? AND f.created_at >= ?')
    .get(src, new Date(Date.now() - 14 * 86400_000).toISOString()) as { v: number | null; c: number };

  // sumber konsisten jelek (>=8 feedback, avg < -0.5) → cooldown 3 hari
  if ((srcRecent.c ?? 0) >= 8 && (srcRecent.v ?? 0) < -0.5) {
    db.prepare(
      `INSERT INTO source_health(source, consec_fail, dead_until, last_error, updated_at)
       VALUES(?, 0, ?, 'low user feedback score', ?)
       ON CONFLICT(source) DO UPDATE SET dead_until = excluded.dead_until, last_error = excluded.last_error, updated_at = excluded.updated_at`,
    ).run(src, new Date(Date.now() + 3 * 86400_000).toISOString(), new Date().toISOString());
    logLearn('source_cooldown', `${src} dinonaktifkan 3 hari (feedback avg ${(srcRecent.v ?? 0).toFixed(2)}, n=${srcRecent.c})`);
  }
}

export function sourceDisabled(source: string): boolean {
  const row = db.prepare('SELECT dead_until FROM source_health WHERE source = ?').get(source) as { dead_until: string | null } | undefined;
  if (!row?.dead_until) return false;
  return new Date(row.dead_until).getTime() > Date.now();
}

export function markSourceFail(source: string, error: string): void {
  db.prepare(
    `INSERT INTO source_health(source, consec_fail, last_error, updated_at) VALUES(?, 1, ?, ?)
     ON CONFLICT(source) DO UPDATE SET consec_fail = consec_fail + 1, last_error = excluded.last_error, updated_at = excluded.updated_at`,
  ).run(source, error.slice(0, 200), new Date().toISOString());
  const row = db.prepare('SELECT consec_fail FROM source_health WHERE source = ?').get(source) as { consec_fail: number } | undefined;
  const fails = row?.consec_fail ?? 0;
  if (fails >= 4) {
    db.prepare('UPDATE source_health SET dead_until = ? WHERE source = ?').run(new Date(Date.now() + 6 * 3600_000).toISOString(), source);
    logLearn('source_cooldown', `${source} auto-cooldown 6 jam setelah ${fails}x gagal berurutan (${error.slice(0, 80)})`);
  }
}

export function markSourceOk(source: string): void {
  db.prepare(
    `INSERT INTO source_health(source, consec_fail, updated_at) VALUES(?, 0, ?)
     ON CONFLICT(source) DO UPDATE SET consec_fail = 0, dead_until = NULL, updated_at = excluded.updated_at`,
  ).run(source, new Date().toISOString());
}

/** Query bank dinamis: query DDG/X yang dipelajari dari judul feedback-positive. */
export function promotedQueries(limit = 3): string[] {
  const rows = db
    .prepare('SELECT query FROM learned_queries WHERE active = 1 ORDER BY hits DESC, created_at DESC LIMIT ?')
    .all(limit) as { query: string }[];
  return rows.map((r) => r.query);
}

export function learnQuery(query: string, source: string): void {
  const q = query.trim().slice(0, 120);
  if (q.length < 10) return;
  db.prepare('INSERT OR IGNORE INTO learned_queries(source, query, active, hits, created_at) VALUES(?,?,?,?,?)').run(source, q, 1, 0, new Date().toISOString());
}

export function hitQuery(query: string): void {
  db.prepare('UPDATE learned_queries SET hits = hits + 1 WHERE query = ?').run(query);
}

/** Signal drift: topik "X gratis" muncul >= threshold dari >=2 sumber beda → auto /watch. */
const MODEL_TOKEN_RE = /\b([a-z][\w]*(?:[-.][\w]+)*[-.]?(?:free|flash|pro|max|mini|ultra|lite)\b|\b(?:glm|qwen|llama|deepseek|kimi|minimax|grok|gpt|gemini|claude|groq)[\w.-]*\b)/gi;

export function detectEmergingTopics(): string[] {
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();
  const rows = db
    .prepare(`SELECT title, url, source FROM intel_items WHERE found_at >= ? AND score >= 0 ORDER BY found_at DESC LIMIT 200`)
    .all(since) as { title: string; url: string; source: string }[];

  const counts = new Map<string, { n: number; sources: Set<string> }>();
  for (const r of rows) {
    const lower = r.title.toLowerCase();
    if (!/(free|gratis|promo|credit|open weight)/i.test(lower)) continue;
    const matches = lower.match(MODEL_TOKEN_RE);
    if (!matches) continue;
    const frag = matches[0].trim();
    if (frag.length < 3 || /^(free|flash|pro|max|mini|ultra|lite)$/.test(frag)) continue;
    const e = counts.get(frag) ?? { n: 0, sources: new Set<string>() };
    e.n++;
    e.sources.add(r.source);
    counts.set(frag, e);
  }

  const emerged: string[] = [];
  for (const [frag, e] of counts) {
    if (e.n >= 3 && e.sources.size >= 2) {
      const exists = db.prepare('SELECT 1 FROM watch WHERE keyword = ?').get(frag);
      if (!exists) {
        db.prepare('INSERT OR IGNORE INTO watch(keyword, created_at) VALUES(?, ?)').run(frag, new Date().toISOString());
        emerged.push(frag);
        logLearn('auto_watch', `"${frag}" auto-watch (${e.n}x dari ${e.sources.size} sumber)`);
      }
    }
  }
  return emerged;
}

export function logLearn(kind: string, detail: string): void {
  db.prepare('INSERT INTO learn_log(kind, detail, created_at) VALUES(?,?,?)').run(kind, detail, new Date().toISOString());
}

/** Ringkasan aktivitas pembelajaran untuk /status & digest. */
export function learningDigest(): string[] {
  const rows = db.prepare('SELECT kind, detail, created_at FROM learn_log ORDER BY id DESC LIMIT 8').all() as { kind: string; detail: string; created_at: string }[];
  return rows.map((r) => `• <i>[${r.kind}]</i> ${r.detail}`);
}
