import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(join(config.dataDir, 'oracle.db'));

db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS articles (
  hash TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  summary TEXT,
  published_at TEXT,
  collected_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_models (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  name TEXT,
  ctx INTEGER,
  first_seen TEXT NOT NULL,
  PRIMARY KEY (provider, model_id)
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_providers (
  name TEXT PRIMARY KEY,
  base_url TEXT,
  key_url TEXT,
  credit_card TEXT,
  free_models INTEGER,
  best_model TEXT,
  best_model_id TEXT,
  max_context TEXT,
  rate_limit TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS x_posts (
  hash TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  snippet TEXT,
  query TEXT,
  found_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_pub ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_chat ON history(chat_id, id DESC);
`);

export function kvGet(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function kvSet(key: string, value: string): void {
  db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function remember(chatId: string, role: string, content: string): void {
  db.prepare('INSERT INTO history(chat_id, role, content, ts) VALUES(?, ?, ?, ?)').run(chatId, role, content, new Date().toISOString());
  db.prepare(`DELETE FROM history WHERE chat_id = ? AND id NOT IN (SELECT id FROM history WHERE chat_id = ? ORDER BY id DESC LIMIT 20)`).run(chatId, chatId);
}

export function recentHistory(chatId: string, n = 8): { role: string; content: string }[] {
  const rows = db.prepare('SELECT role, content FROM history WHERE chat_id = ? ORDER BY id DESC LIMIT ?').all(chatId, n) as { role: string; content: string }[];
  return rows.reverse();
}
