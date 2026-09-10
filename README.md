# ORACLE Bot

☀️ Asisten Telegram: chat AI ber-grounding web real-time + tracker berita finansial (global & Indonesia) + pemantau model AI gratis + market data + digest & alert.

## Fitur

| Perintah | Fungsi |
| --- | --- |
| `chat bebas` / `/ask` | Tanya apa pun — dijawab LLM (glm-5.3) dengan hasil pencarian web DuckDuckGo real-time + sitasi |
| `/news`, `/newsid` | Berita finansial terbaru global / Indonesia (dari 7 RSS feed) |
| `/price` | BTC/ETH/SOL (CoinGecko), USD/IDR (Frankfurter), saham US opsional (Twelve Data) |
| `/digest` | Morning brief: ringkasan AI + market + headlines + model AI free baru |
| `/aifree`, `/aiscan`, `/airecap` | Pantau free AI models di OpenRouter (deteksi baru via diff) + repo awesome-free-llm-apis |
| `/watch` | Watchlist keyword — push breaking news otomatis |
| `/scan` | Paksa scan RSS sekarang |

Scheduler: RSS tiap 30 menit, AI tracker tiap 6 jam, digest 06:30 WIB harian, rekap AI Senin 09:00.

## Stack

TypeScript ESM · grammY (long-polling) · `node:sqlite` (zero native deps) · node-cron · fast-xml-parser

LLM chain fallback: TokenRouter (`z-ai/glm-5.3-free`) → B.AI (`glm-5.3-flash`) → DevStack lokal.

## Setup

```bash
npm ci
cp .env.example .env   # isi TELEGRAM_BOT_TOKEN, OWNER_CHAT_ID, ALLOWED_CHAT_IDS, API keys
npm run dev            # atau: npm run build && npm start
```

Test tanpa Telegram:

```bash
npm run cli -- rss       # scan RSS ke SQLite
npm run cli -- market    # harga crypto + kurs
npm run cli -- digest    # morning brief dry-run
npm run cli -- ask "IHSG sekarang?"
```

Bot token: chat [@BotFather](https://t.me/BotFather) → `/newbot`. Chat ID sendiri: kirim pesan ke bot → cek log `rejected chat <id>`.

## Deploy

Panduan lengkap: [`deploy/ORACLE-CLOUD.md`](deploy/ORACLE-CLOUD.md) (Oracle Cloud Always Free ARM + systemd + logrotate).

## Author

**Author:** Raliq Hidayat BM3
