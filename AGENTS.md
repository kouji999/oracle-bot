# AGENTS.md — oracle-bot

Telegram AI bot: chat AI (LLM+DDG grounding), finance news (global+ID), free-AI provider tracker, market data, digest/alerts.

## Stack
- TypeScript ESM (strict), Node >=22.5 (paket `node:sqlite` built-in — JANGAN pakai better-sqlite3)
- grammY (long-polling), node-cron, fast-xml-parser
- Zero native deps. Build: `npm run build`. Run: `npm start` (dist) / `npm run dev` (tsx).
- DB: `data/oracle.db` (SQLite WAL). Schema di src/db.ts.

## Perintah
- `npm run typecheck` — wajib 0 error sebelum selesai
- `npm run cli -- rss|ai|market|ddg|digest|ask|help` — test collector/command tanpa Telegram
- Bot jalan butuh `TELEGRAM_BOT_TOKEN` di .env. Kredensial JANGAN pernah di-commit.

## Arsitektur
- src/config.ts — env loader (.env) + llmChain (tokenrouter → b.ai → devstack lokal)
- src/llm.ts — chain fallback + tolerant JSON parse (router bisa nempel `data: [DONE]`)
- src/search.ts — DDG search (2 strategi: html POST + lite GET), fragile scraping — kalau rusak cek selector
- src/collectors/rss.ts — FEEDS list; tambah feed = tambah entry FEEDS
- src/collectors/ai.ts — OpenRouter free-model diff + GitHub repo commits tracker (state di kv table)
- src/collectors/market.ts — CoinGecko + Frankfurter (USD/IDR) + Twelve Data (opsional)
- src/digest.ts — morning brief + weekly AI recap (LLM summary + raw data)
- src/bot/commands.ts — semua handler command/chat; format HTML Telegram, max 4096 char (split di scheduler.ts)
- src/scheduler.ts — cron: rss 30m, ai 6h, digest 06:30 WIB, weekly Senin 09:00; watch keyword alert
- src/cli.ts — harness verifikasi tanpa Telegram

## X Session (Twitter) — Refresh Runbook

Bot X live pakai cookie `X_AUTH_TOKEN` + `X_CT0` dari akun user (read-only, aman untuk akun suspend). Cookie ini dipakai tanpa browser — langsung via Node fetch ke GraphQL X.

**Kalau bot alert "Sesi X (Twitter) expired"**, langkah:
1. Buka `https://x.com` di browser, login pakai Google One Tap / akun lu
2. Buka DevTools → Application → Cookies → x.com
3. Copy value: `auth_token` + `ct0`
4. Update `.env`:
   ```
   X_AUTH_TOKEN=auth_token_value_baru
   X_CT0=ct0_value_baru
   ```
5. `powershell -ExecutionPolicy Bypass -File deploy\restart-laptop.ps1`
6. Bot otomatis lanjut monitoring (karena `x_session_dead_since` akan ke-reset pas scan berikutnya sukses)

Cookie expiry: ~1 tahun. Lebih cepet kalau revoke manual / security reset.

## Aturan
- Semua kredensial via .env (gitignored). Provider baru → update docs/api-catalog.md + .env.example.
- Semua external call: timeout + graceful error. Jangan pernah crash process karena satu feed/API mati.
- Pesan Telegram: parse_mode HTML — escape input user sebelum masuk template kalau mengandung <, >, &.
- Waktu user: Asia/Jakarta.
