# API Catalog — oracle-bot (verified 2026-09-10)

Format: base URL | key | free tier | auth

## LLM (chain fallback: tokenrouter → b.ai → devstack)
- **TokenRouter** — `https://api.tokenrouter.com/v1` | key: user-provided | model `z-ai/glm-5.3-free` | `Authorization: Bearer` | verified 2026-09-10 (chat 200, 1.6s; /models = 1 model)
- **B.AI** — `https://api.b.ai/v1` | key: user-provided | model `glm-5.3-flash` (+47 models tersedia: gpt-5.x, claude, minimax) | `Authorization: Bearer` | verified 2026-09-10 (chat 200, 1.65s)
- **DevStack (lokal)** — `http://127.0.0.1:20128/v1` | key: env `DEVSTACK_API_KEY` | model `9router/Dev-Stack` | hanya hidup di laptop user, tidak ada di VPS

## Telegram Bot API
- `https://api.telegram.org/bot<token>/...` | token dari @BotFather | gratis, unlimited, long-polling `getUpdates` | rate: ~30 msg/s global, 1 msg/s per chat, 4096 char per pesan

## Data — no key
- **RSS finance** (fetch + fast-xml-parser, dedup by URL hash):
  - Yahoo Finance `https://finance.yahoo.com/news/rssindex` (global)
  - CNBC Markets `https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258` (global)
  - MarketWatch `https://feeds.content.dowjones.io/public/rss/mw_topstories` (global)
  - Nasdaq `https://www.nasdaq.com/feed/rssoutbound?category=Markets` (global)
  - Kontan `https://www.kontan.co.id/rss/index` (indonesia)
  - Bisnis.com `https://www.bisnis.com/rss` (indonesia)
- **CoinGecko** — `https://api.coingecko.com/api/v3` | keyless public = rate rendah (OK utk 5menit+); Demo key free 10k/mo via env `COINGECKO_DEMO_KEY` | header `x-cg-demo-api-key`
- **Frankfurter** — `https://api.frankfurter.dev/v2` (⚠ domain lama .app = 301) | no key | kurs ECB, ada IDR
- **OpenRouter models (public)** — `https://openrouter.ai/api/v1/models` | no auth | diff untuk deteksi model free baru (pricing.prompt=="0")
- **GitHub API** — `https://api.github.com/repos/{repo}/releases|commits` | no auth 60 req/h, UA header wajib | repos: mnfst/awesome-free-llm-apis, open-free-llm-api/awesome-freellm-apis, 12britz/awesome-free-models
- **DuckDuckGo (unofficial)** — `https://html.duckduckgo.com/html/` POST q / `https://lite.duckduckgo.com/lite/?q=` GET | no key, scraping rapuh → fallback chain

## Data — opsional key
- **Twelve Data** — `https://api.twelvedata.com` | key: twelvedata.com/account/api-keys | Basic 8 credits/min, 800/day | saham quote (`TWELVEDATA_API_KEY`) — belum dipakai MVP

## Rules
- Semua kredensial via env (.env gitignored). Jangan hardcode.
- Semua call eksternal: timeout + error handling + graceful skip. Critical path (LLM) pakai fallback chain.
- Provider baru → verifikasi docs resmi dulu → tambah entry di sini + .env.example.
