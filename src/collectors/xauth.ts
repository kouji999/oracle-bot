import { createHash } from 'node:crypto';
import { db, kvGet, kvSet } from '../db.js';
import { config } from '../config.js';
import type { IntelItem } from './intel.js';

/**
 * xauth.ts — X (Twitter) read-only collector pakai session cookie akun sendiri.
 * Endpoint GraphQL web X + bearer publik + csrf ct0. Read-only aman utk akun suspend.
 */

const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const FEATURES = JSON.stringify({
  responsive_web_graphql_exclude_default: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  longform_notetweets_consumption_enabled: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  premium_content_api_read_enabled: false,
  view_counts_everywhere_api_enabled: true,
});

const QUERY_IDS: Record<string, string> = {
  UserByScreenName: 'G3KGOASz96M-Qu0nwmGXNg',
  UserOriginalsTimeline: 'z_JDHIa1yBS42jLdUH1j3A',
};

/** Akun X resmi yang dipantau posting-annya (free-AI provider + aggregator intelijen). */
export const WATCHED_ACCOUNTS: { screen: string; label: string }[] = [
  { screen: 'OpenRouter', label: 'aggregator — free model launches' },
  { screen: 'tokenrouter', label: 'TokenRouter' },
  { screen: 'MiniMax_Ai', label: 'MiniMax' },
  { screen: 'Alibaba_Qwen', label: 'Qwen (Alibaba)' },
  { screen: 'deepseek_ai', label: 'DeepSeek' },
  { screen: 'ZaiGLM', label: 'GLM (Z.ai)' },
  { screen: 'moonshotai', label: 'Kimi (Moonshot)' },
  { screen: 'cerebras', label: 'Cerebras (fast inference)' },
  { screen: 'GroqInc', label: 'Groq' },
  { screen: 'MistralAI', label: 'Mistral' },
  { screen: 'sambanova', label: 'SambaNova' },
  { screen: 'novita_labs', label: 'Novita' },
  { screen: 'NVIDIAAIDev', label: 'NVIDIA AI (NIM free tier)' },
  { screen: 'huggingface', label: 'Hugging Face' },
  { screen: 'ollama', label: 'Ollama' },
  { screen: 'xai', label: 'xAI' },
  { screen: 'OpenAI', label: 'OpenAI' },
  { screen: 'GoogleDeepMind', label: 'Google DeepMind' },
  { screen: 'TogetherCompute', label: 'Together AI' },
  { screen: 'fireworks_ai', label: 'Fireworks AI' },
  { screen: 'chutes_ai', label: 'Chutes.ai' },
  { screen: 'kilocode', label: 'Kilo Code' },
  { screen: 'dr_cintas', label: 'free-AI-tier tracker' },
];

function headers(): Record<string, string> {
  return {
    authorization: `Bearer ${BEARER}`,
    cookie: `auth_token=${config.x.authToken}; ct0=${config.x.ct0}`,
    'x-csrf-token': config.x.ct0,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    referer: 'https://x.com/',
  };
}

export function xAuthConfigured(): boolean {
  return Boolean(config.x.authToken && config.x.ct0);
}

async function gql(opName: string, variables: Record<string, unknown>, extra = ''): Promise<unknown> {
  if (!xAuthConfigured()) throw new Error('X session belum dikonfigurasi (X_AUTH_TOKEN/X_CT0)');
  const url =
    `https://x.com/i/api/graphql/${QUERY_IDS[opName]}/${opName}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(FEATURES)}${extra}`;
  const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(20_000) });
  if (r.status === 401 || r.status === 403) {
    kvSet('x_session_dead_since', new Date().toISOString());
    throw new Error('X_SESSION_EXPIRED');
  }
  if (!r.ok) throw new Error(`X API HTTP ${r.status}`);
  return r.json();
}

export function xSessionStatus(): { live: boolean; deadSince: string | null } {
  const v = kvGet('x_session_dead_since');
  return v ? { live: false, deadSince: v } : { live: true, deadSince: null };
}

interface TweetLike {
  id_str: string;
  full_text: string;
  created_at: string;
  user?: { screen_name?: string };
}

function extractTweets(j: unknown): TweetLike[] {
  const out: TweetLike[] = [];
  const seen = new Set<string>();
  function walk(o: unknown) {
    if (!o || typeof o !== 'object') return;
    const t = o as { full_text?: string; id_str?: string; created_at?: string; user?: { screen_name?: string } };
    if (typeof t.full_text === 'string' && typeof t.id_str === 'string' && typeof t.created_at === 'string') {
      if (!seen.has(t.id_str)) {
        seen.add(t.id_str);
        out.push({ id_str: t.id_str, full_text: t.full_text, created_at: t.created_at, user: t.user });
      }
      return; // jangan turun ke children tweet-tweet
    }
    for (const v of Object.values(o as Record<string, unknown>)) if (v && typeof v === 'object') walk(v);
  }
  walk(j);
  return out;
}

async function resolveUserId(screen: string): Promise<string | null> {
  const cached = db.prepare('SELECT rest_id FROM x_users WHERE screen_name = ?').get(screen) as { rest_id: string } | undefined;
  if (cached?.rest_id) return cached.rest_id;
  const j = (await gql('UserByScreenName', { screen_name: screen, withSafetyModeUserFields: true })) as {
    data?: { user?: { result?: { rest_id?: string } } };
  };
  const id = j?.data?.user?.result?.rest_id ?? null;
  if (id) db.prepare('INSERT OR REPLACE INTO x_users(screen_name, rest_id, label, checked_at) VALUES(?,?,?,?)').run(screen, id, screen, new Date().toISOString());
  return id;
}

export async function scanXSession(): Promise<{ newItems: IntelItem[]; alerts: string[]; errors: string[]; checked: number }> {
  if (!xAuthConfigured()) return { newItems: [], alerts: [], errors: ['X session belum dikonfigurasi'], checked: 0 };
  const newItems: IntelItem[] = [];
  const alerts: string[] = [];
  const errors: string[] = [];
  let checked = 0;

  for (const acct of WATCHED_ACCOUNTS) {
    try {
      const id = await resolveUserId(acct.screen);
      if (!id) {
        errors.push(`${acct.screen}: user id tidak ditemukan`);
        continue;
      }
      const j = await gql(
        'UserOriginalsTimeline',
        { userId: id, count: 20, includePromotedContent: false, withQuickPromoteEligibilityTweetFields: false, withVoice: false },
        '&fieldToggles=%7B%22withArticlePlainText%22%3Afalse%7D',
      );
      const tweets = extractTweets(j);
      checked++;
      const lastSeen = (db.prepare('SELECT last_seen_id FROM x_users WHERE screen_name = ?').get(acct.screen) as { last_seen_id: string | null } | undefined)?.last_seen_id ?? null;
      const insert = db.prepare('INSERT OR IGNORE INTO intel_items(hash, source, origin, title, url, snippet, found_at) VALUES(?,?,?,?,?,?,?)');
      let inserted = 0;
      let first = true;
      for (const t of tweets) {
        const url = `https://x.com/${acct.screen}/status/${t.id_str}`;
        if (lastSeen === t.id_str) break;
        const hash = createHash('sha1').update(url).digest('hex');
        const r = insert.run(hash, 'X (live)', `@${acct.screen}`, t.full_text.slice(0, 160), url, t.full_text.slice(160, 400), new Date().toISOString());
        if (r.changes > 0) {
          inserted++;
          newItems.push({ hash, source: 'X (live)', origin: `@${acct.screen}`, title: t.full_text.slice(0, 160), url, snippet: t.full_text.slice(160, 400) });
        }
        if (first) {
          db.prepare('UPDATE x_users SET last_seen_id = ?, checked_at = ? WHERE screen_name = ?').run(t.id_str, new Date().toISOString(), acct.screen);
          first = false;
        }
      }
      if (inserted > 0) alerts.push(`🐦 @${acct.screen} (${acct.label}): ${inserted} posting-an baru`);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === 'X_SESSION_EXPIRED') {
        const prevDead = kvGet('x_session_dead_since');
        const firstTime = !prevDead || prevDead.slice(0, 10) < new Date(Date.now() - 3600_000).toISOString().slice(0, 10);
        errors.push('X session expired (401/403) — refresh: login x.com → salin cookie auth_token & ct0 → update .env → restart (runbook di AGENTS.md)');
        if (firstTime) alerts.push('⚠️ <b>Sesi X (Twitter) expired</b> — pemantauan X pause sampai session di-refresh. Bilang ke agent: "refresh X session".');
        return { newItems, alerts, errors, checked };
      }
      errors.push(`${acct.screen}: ${msg}`);
    }
  }

  if (checked > 0) db.prepare("DELETE FROM kv WHERE key = 'x_session_dead_since'").run();

  kvSet('last_x_live_scan', new Date().toISOString());
  return { newItems, alerts, errors, checked };
}
