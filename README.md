# ORACLE Bot

☀️ **Market & AI Provider Intelligence** — bot Telegram: asisten AI ber-grounding web real-time, intelijen provider AI gratis (prioritas posting-an X), berita finansial global + Indonesia, market data, dan ringkasan harian otomatis.

## Fitur

### 🤖 Asisten AI
| Perintah | Fungsi |
| --- | --- |
| chat bebas / `ask` | Tanya apa pun — dijawab LLM (glm-5.3) dengan pencarian web real-time + sitasi |

### 🧩 Provider AI Gratis (prioritas intelijen X)
| Perintah | Fungsi |
| --- | --- |
| `xai` | Intelijen X: posting-an orang tentang provider/model AI gratis (scan live + otomatis per jam) |
| `prov` | Direktori 30+ provider AI gratis: base URL, jumlah model, rate limit, syarat kartu |
| `prov <nama>` | Detail provider + snippet konfigurasi OpenAI-compatible siap tempel (router/proxy) |
| `aifree` | Model gratis OpenRouter terpantau (deteksi model baru via diff) |
| `aiscan` | Pindai menyeluruh: OpenRouter, direktori provider, X, repositori tracker |
| `airecap` | Rekap mingguan ekosistem AI gratis |

### 📈 Pasar & Berita
| Perintah | Fungsi |
| --- | --- |
| `news` / `newsid` | Berita finansial global / Indonesia (7 kanal RSS) |
| `price` | BTC/ETH/SOL (CoinGecko), USD/IDR (Frankfurter) |
| `digest` | Morning brief: ringkasan analis + pasar + headline + intelijen X |

### ⚙️ Operasional
| Perintah | Fungsi |
| --- | --- |
| `watch <keyword>` | Notifikasi breaking news berdasarkan kata kunci |
| `status` | Kondisi layanan: jumlah data, waktu sinkronisasi terakhir, LLM chain |

**Scheduler**: RSS tiap 30 menit · intelijen X tiap jam · direktori provider 2x sehari · AI tracker 6 jam · morning brief 06:30 WIB · rekap AI Senin 09:00.

## Stack

TypeScript ESM (strict) · grammY (long-polling) · `node:sqlite` (zero native deps) · node-cron · fast-xml-parser

**LLM chain** (fallback otomatis): TokenRouter (`z-ai/glm-5.3-free`) → B.AI (`glm-5.3-flash`) → DevStack lokal.

## Setup

```bash
npm ci
cp .env.example .env   # isi TELEGRAM_BOT_TOKEN, OWNER_CHAT_ID, ALLOWED_CHAT_IDS, API keys
npm start              # build + jalankan: npm run build && node dist/index.js
```

Bot token dari [@BotFather](https://t.me/BotFather) → `/newbot`. Chat ID tersedia di log baris `rejected chat <id>` saat orang lain mengirim pesan pertama.

## Verifikasi tanpa Telegram

```bash
npm run cli -- rss       # pindai RSS → SQLite
npm run cli -- xai       # intelijen X: provider AI
npm run cli -- prov      # sinkronisasi direktori provider
npm run cli -- digest    # morning brief (dry-run)
```

## Deploy

Panduan lengkap: [`deploy/ORACLE-CLOUD.md`](deploy/ORACLE-CLOUD.md) — Oracle Cloud Always Free (ARM) + systemd + logrotate.

## Author

**Author:** Raliq Hidayat BM3
