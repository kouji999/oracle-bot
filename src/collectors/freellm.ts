import { db, kvSet } from '../db.js';

const REPO_README = 'https://raw.githubusercontent.com/open-free-llm-api/awesome-freellm-apis/main/README.md';

export interface ProviderRow {
  name: string;
  baseUrl: string | null;
  keyUrl: string | null;
  creditCard: string | null;
  freeModels: number | null;
  bestModel: string | null;
  bestModelId: string | null;
  maxContext: string | null;
  rateLimit: string | null;
}

export interface SyncEvent {
  type: 'new_provider' | 'models_up' | 'models_down';
  name: string;
  from?: number;
  to?: number;
}

export interface SyncResult {
  ok: boolean;
  total: number;
  events: SyncEvent[];
  error?: string;
}

function extractSection(md: string, marker: string): string | null {
  const begin = md.match(new RegExp(`<!-- BEGIN_${marker} -->([\\s\\S]*?)<!-- END_${marker} -->`));
  return begin ? begin[1] : null;
}

function parseTable(section: string): string[][] {
  return section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && !/^\|[\s|:-]+\|?$/.test(l))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
}

function stripMd(s: string): string {
  return s
    .replace(/<a[^>]*href="([^"]+)"[^>]*>.*?<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .trim();
}

function extractHref(s: string): string | null {
  const m = s.match(/href="([^"]+)"/i);
  return m ? m[1] : null;
}

function normName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function parseRepo(md: string): Map<string, ProviderRow> {
  const map = new Map<string, ProviderRow>();
  const ensure = (name: string): ProviderRow => {
    const k = normName(name);
    let r = map.get(k);
    if (!r) {
      r = { name, baseUrl: null, keyUrl: null, creditCard: null, freeModels: null, bestModel: null, bestModelId: null, maxContext: null, rateLimit: null };
      map.set(k, r);
    }
    return r;
  };

  for (const marker of ['PERMANENT_FREE', 'RENEWABLE']) {
    const sec = extractSection(md, marker);
    if (!sec) continue;
    for (const row of parseTable(sec)) {
      if (row.length < 4 || normName(row[0]) === 'provider') continue;
      const r = ensure(row[0]);
      r.freeModels = Number(row[1]) || r.freeModels;
      r.creditCard = stripMd(row[2]) || r.creditCard;
      r.maxContext = stripMd(row[3]) || r.maxContext;
      const key = row[row.length - 1];
      r.keyUrl = extractHref(key) || r.keyUrl;
    }
  }

  const qref = extractSection(md, 'QUICK_REF');
  if (qref) {
    for (const row of parseTable(qref)) {
      if (row.length < 2 || normName(row[0]) === 'provider') continue;
      const r = ensure(row[0]);
      const url = stripMd(row[1]);
      if (url.startsWith('http')) r.baseUrl = url;
      if (row[2]) r.keyUrl = extractHref(row[2]) || r.keyUrl;
      if (row[3]) r.creditCard = stripMd(row[3]) || r.creditCard;
    }
  }

  const best = extractSection(md, 'BEST_MODELS');
  if (best) {
    let lastProvider = '';
    for (const row of parseTable(best)) {
      if (row.length < 3 || normName(row[0]) === 'provider' && normName(row[1]) === 'best free model') continue;
      const pname = row[0] || lastProvider;
      if (!pname) continue;
      lastProvider = pname;
      if (row[0]) lastProvider = row[0];
      const r = ensure(pname);
      if (!r.bestModel) {
        r.bestModel = stripMd(row[1]);
        r.bestModelId = stripMd(row[2]);
        if (row[3]) r.maxContext = r.maxContext || stripMd(row[3]);
        if (row[4]) r.rateLimit = stripMd(row[4]);
      }
    }
  }

  return map;
}

export async function syncFreeLlmProviders(): Promise<SyncResult> {
  let md: string;
  try {
    const r = await fetch(REPO_README, { signal: AbortSignal.timeout(25_000) });
    if (!r.ok) return { ok: false, total: 0, events: [], error: `HTTP ${r.status}` };
    md = await r.text();
  } catch (e) {
    return { ok: false, total: 0, events: [], error: (e as Error).message };
  }

  const rows = parseRepo(md);
  const events: SyncEvent[] = [];
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO ai_providers(name, base_url, key_url, credit_card, free_models, best_model, best_model_id, max_context, rate_limit, first_seen, last_seen)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET
       base_url=COALESCE(excluded.base_url, base_url),
       key_url=COALESCE(excluded.key_url, key_url),
       credit_card=COALESCE(excluded.credit_card, credit_card),
       free_models=COALESCE(excluded.free_models, free_models),
       best_model=COALESCE(excluded.best_model, best_model),
       best_model_id=COALESCE(excluded.best_model_id, best_model_id),
       max_context=COALESCE(excluded.max_context, max_context),
       rate_limit=COALESCE(excluded.rate_limit, rate_limit),
       last_seen=excluded.last_seen`,
  );

  for (const r of rows.values()) {
    const prev = db.prepare('SELECT free_models FROM ai_providers WHERE name = ?').get(r.name) as { free_models: number | null } | undefined;
    upsert.run(r.name, r.baseUrl, r.keyUrl, r.creditCard, r.freeModels, r.bestModel, r.bestModelId, r.maxContext, r.rateLimit, now, now);
    if (!prev) {
      events.push({ type: 'new_provider', name: r.name, to: r.freeModels ?? undefined });
    } else if (r.freeModels != null && prev.free_models != null) {
      if (r.freeModels > prev.free_models) events.push({ type: 'models_up', name: r.name, from: prev.free_models, to: r.freeModels });
      else if (r.freeModels < prev.free_models) events.push({ type: 'models_down', name: r.name, from: prev.free_models, to: r.freeModels });
    }
  }

  const total = (db.prepare('SELECT COUNT(*) c FROM ai_providers').get() as { c: number }).c;
  kvSet('last_prov_sync', new Date().toISOString());
  return { ok: true, total, events };
}

export function listProviders(): ProviderRow[] {
  const rows = db.prepare('SELECT * FROM ai_providers ORDER BY free_models DESC').all() as Record<string, unknown>[];
  return rows.map((r) => ({
    name: String(r.name),
    baseUrl: r.base_url ? String(r.base_url) : null,
    keyUrl: r.key_url ? String(r.key_url) : null,
    creditCard: r.credit_card ? String(r.credit_card) : null,
    freeModels: r.free_models != null ? Number(r.free_models) : null,
    bestModel: r.best_model ? String(r.best_model) : null,
    bestModelId: r.best_model_id ? String(r.best_model_id) : null,
    maxContext: r.max_context ? String(r.max_context) : null,
    rateLimit: r.rate_limit ? String(r.rate_limit) : null,
  }));
}

export function findProvider(q: string): ProviderRow | undefined {
  const all = listProviders();
  const n = normName(q);
  return all.find((p) => normName(p.name) === n) ?? all.find((p) => normName(p.name).includes(n)) ?? all.find((p) => (p.bestModelId ?? '').toLowerCase().includes(n));
}
