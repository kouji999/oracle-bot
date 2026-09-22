import { Bot, GrammyError, HttpError, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { runInitialCollect, startScheduler, splitTelegram, type Notifier } from './scheduler.js';
import { handleUpdateText, takeIntelMap } from './bot/commands.js';

function buildVoteKb(hashes: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  hashes.slice(0, 8).forEach((h, i) => {
    kb.text(`👍 ${i + 1}`, `fb:${h.slice(0, 8)}:up`).text(`👎 ${i + 1}`, `fb:${h.slice(0, 8)}:down`);
    kb.row();
  });
  return kb;
}

export function createBot(): Bot {
  const bot = new Bot(config.botToken);

  const allowed = new Set(config.allowedChatIds.filter(Boolean));
  if (allowed.size === 0) {
    console.warn('[bot] ALLOWED_CHAT_IDS kosong — semua chat bisa akses (dev mode). Set di .env untuk produksi!');
  }

  bot.use(async (ctx, next) => {
    const id = String(ctx.chat?.id ?? '');
    if (allowed.size > 0 && !allowed.has(id)) {
      console.warn(`[bot] rejected chat ${id}`);
      return;
    }
    await next();
  });

  // tombol vote inline dari /intel
  bot.callbackQuery(/^fb:/, async (ctx) => {
    const m = ctx.callbackQuery.data.match(/^fb:(\w{6,16}):(up|down)$/);
    if (!m) return ctx.answerCallbackQuery({ text: 'Tombol kadaluarsa — jalankan /intel lagi.' });
    const short = m[1];
    const dir = m[2] === 'up' ? 1 : -1;
    try {
      const { recordFeedback } = await import('./learning.js');
      const { db } = await import('./db.js');
      const row = db.prepare('SELECT hash FROM intel_items WHERE hash LIKE ?').get(`${short}%`) as { hash: string } | undefined;
      if (!row) {
        await ctx.answerCallbackQuery({ text: 'Temuan sudah tidak dikenal — jalankan /intel lagi.' });
        return;
      }
      const chatId = String(ctx.chat?.id ?? '');
      recordFeedback(row.hash, dir as 1 | -1, chatId);
      if (dir > 0) {
        const item = db.prepare('SELECT title FROM intel_items WHERE hash = ?').get(row.hash) as { title: string } | undefined;
        if (item) {
          const { learnQuery } = await import('./learning.js');
          learnQuery(item.title.slice(0, 100), 'user-feedback');
        }
      }
      const scored = db.prepare('SELECT score FROM intel_items WHERE hash = ?').get(row.hash) as { score: number } | undefined;
      await ctx.answerCallbackQuery({ text: dir > 0 ? '✅ Tercatat: relevan — bot belajar dari vote ini' : '🗑 Tercatat: noise — bobot diturunkan' });
      await ctx.editMessageReplyMarkup({
        reply_markup: { inline_keyboard: [[{ text: dir > 0 ? '✅ dinilai relevan' : '🗑 dinilai noise', callback_data: `done:${short}` }]] },
      }).catch(() => undefined);
      console.log(`[fb] vote ${dir > 0 ? '+' : '-'} ${short} (score ${scored?.score ?? '?'})`);
    } catch (e) {
      await ctx.answerCallbackQuery({ text: 'Gagal memproses vote.' }).catch(() => undefined);
      console.error('[fb-cb]', (e as Error).message);
    }
  });

  bot.callbackQuery(/^done:/, (ctx) => ctx.answerCallbackQuery({ text: 'Sudah dinilai.' }));

  bot.on('message:text', async (ctx) => {
    const chatId = String(ctx.chat.id);
    try {
      const text = ctx.message.text;
      const isCommand = text.startsWith('/');
      if (isCommand) await ctx.api.sendChatAction(chatId, 'typing');
      else await ctx.api.sendChatAction(chatId, 'typing');
      const reply = await handleUpdateText(chatId, text);
      if (reply === null) {
        if (isCommand) await ctx.reply('Command ga dikenal. /help buat daftar.');
        else await ctx.reply('Kirim /help buat liat fitur, atau /ask <i>pertanyaan</i>.', { parse_mode: 'HTML' });
        return;
      }
      const cmdLc = (text.trim().split(/\s+/)[0] ?? '').toLowerCase();
      const voteHashes = cmdLc === '/intel' || cmdLc === '/xai' ? takeIntelMap(chatId) : [];
      const parts = splitTelegram(reply);
      for (let i = 0; i < parts.length; i++) {
        await ctx.reply(parts[i], {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(i === 0 && voteHashes.length ? { reply_markup: buildVoteKb(voteHashes) } : {}),
        });
      }
    } catch (e) {
      console.error('[bot] handler error:', (e as Error).message);
      await ctx.reply(`⚠ Error: ${(e as Error).message.slice(0, 300)}`).catch(() => undefined);
    }
  });

  bot.catch((err) => {
    const e = err.error as { message?: string; description?: string };
    console.error('[bot] error boundary:', e?.message ?? String(e));
    if (e instanceof GrammyError) {
      console.error('  grammy:', (e as unknown as { description?: string }).description ?? e.message);
    } else if (e instanceof HttpError) {
      console.error('  http error');
    }
  });

  return bot;
}

export async function main(): Promise<void> {
  if (!config.botToken) {
    console.error('TELEGRAM_BOT_TOKEN kosong — isi .env dulu.');
    process.exit(1);
  }

  const bot = createBot();

  const notify: Notifier = {
    send: async (text: string) => {
      if (!config.ownerChatId) return;
      for (const part of splitTelegram(text)) {
        await bot.api.sendMessage(config.ownerChatId, part, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      }
    },
  };

  console.log('[bot] initial collect...');
  const bootMsg = await runInitialCollect().catch((e) => `Boot collect gagal: ${e.message}`);
  console.log(`[bot] ${bootMsg}`);

  startScheduler(notify);
  console.log('[bot] scheduler aktif (rss 30m · xai 1h · openrouter 6h · provider 5:40/17:40 · digest 06:30 · recap Senin 09:00 WIB)');

  void bot.start({
    onStart: (me) => {
      console.log(`[bot] @${me.username} live sebagai ${me.first_name}`);
      void notify.send(`☀️ <b>VEYRON online</b>\n${bootMsg}`).catch(() => undefined);
    },
  });

  const shutdown = () => {
    console.log('[bot] shutdown...');
    void bot.stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main().catch((e) => {
  console.error('[bot] fatal:', e);
  process.exit(1);
});
