import { db, kvGet, kvSet } from '../db.js';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

const GH_REPOS = [
  'mnfst/awesome-free-llm-apis',
  'open-free-llm-api/awesome-freellm-apis',
  '12britz/awesome-free-models',
];

interface OrModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
}

export interface AiScanResult {
  freeModelsTotal: number;
  newModels: { id: string; name: string; ctx: number }[];
  ghUpdates: { repo: string; type: string; title: string; url: string; date: string }[];
  errors: string[];
}

export async function scanAiProviders(): Promise<AiScanResult> {
  const errors: string[] = [];
  const newModels: AiScanResult['newModels'] = [];
  let freeTotal = 0;

  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 30_000);
    const r = await fetch(OPENROUTER_MODELS_URL, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) throw new Error(`openrouter HTTP ${r.status}`);
    const j = (await r.json()) as { data?: OrModel[] };
    const models = j.data ?? [];
    const free = models.filter((m) => m.pricing?.prompt === '0' && m.pricing?.completion === '0');
    freeTotal = free.length;
    const now = new Date().toISOString();
    const insert = db.prepare('INSERT OR IGNORE INTO ai_models(provider, model_id, name, ctx, first_seen) VALUES(?,?,?,?,?)');
    const touch = db.prepare('UPDATE ai_models SET name = COALESCE(?, name), ctx = COALESCE(?, ctx) WHERE provider = ? AND model_id = ?');
    for (const m of free) {
      const res = insert.run('openrouter', m.id, m.name ?? m.id, m.context_length ?? null, now);
      if (res.changes > 0) newModels.push({ id: m.id, name: m.name ?? m.id, ctx: m.context_length ?? 0 });
      else touch.run(m.name ?? null, m.context_length ?? null, 'openrouter', m.id);
    }
  } catch (e) {
    errors.push(String((e as Error).message));
  }

  const ghUpdates: AiScanResult['ghUpdates'] = [];
  for (const repo of GH_REPOS) {
    try {
      const lastSha = kvGet(`gh_sha_${repo}`);
      const url = lastSha
        ? `https://api.github.com/repos/${repo}/commits?sha=main&since=${encodeURIComponent(kvGet(`gh_since_${repo}`) ?? new Date(Date.now() - 7 * 86400_000).toISOString())}&per_page=10`
        : `https://api.github.com/repos/${repo}/commits?sha=main&per_page=3`;
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 20_000);
      const r = await fetch(url, {
        headers: { 'user-agent': 'oracle-bot', accept: 'application/vnd.github+json' },
        signal: ctrl.signal,
      });
      clearTimeout(to);
      if (!r.ok) throw new Error(`github HTTP ${r.status}`);
      const commits = (await r.json()) as { sha: string; html_url: string; commit: { message: string; author: { date: string } } }[];
      if (commits.length > 0) {
        kvSet(`gh_sha_${repo}`, commits[0].sha);
        kvSet(`gh_since_${repo}`, new Date().toISOString());
        for (const c of commits) {
          if (lastSha && c.sha === lastSha) break;
          ghUpdates.push({
            repo,
            type: 'commit',
            title: c.commit.message.split('\n')[0].slice(0, 120),
            url: c.html_url,
            date: c.commit.author?.date ?? '',
          });
        }
      }
    } catch (e) {
      errors.push(`${repo}: ${String((e as Error).message)}`);
    }
  }

  return { freeModelsTotal: freeTotal, newModels, ghUpdates, errors };
}

export function newFreeModelsSince(hours: number, limit = 10): { id: string; name: string; ctx: number; firstSeen: string }[] {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = db
    .prepare('SELECT model_id, name, ctx, first_seen FROM ai_models WHERE provider = ? AND first_seen >= ? ORDER BY first_seen DESC LIMIT ?')
    .all('openrouter', since, limit) as { model_id: string; name: string; ctx: number; first_seen: string }[];
  return rows.map((r) => ({ id: r.model_id, name: r.name, ctx: r.ctx, firstSeen: r.first_seen }));
}

export function listFreeModels(limit = 15): { id: string; name: string; ctx: number; firstSeen: string }[] {
  const rows = db
    .prepare("SELECT model_id, name, ctx, first_seen FROM ai_models WHERE provider = ? ORDER BY first_seen DESC LIMIT ?")
    .all('openrouter', limit) as { model_id: string; name: string; ctx: number; first_seen: string }[];
  return rows.map((r) => ({ id: r.model_id, name: r.name, ctx: r.ctx, firstSeen: r.first_seen }));
}
