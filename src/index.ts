import { Bot, GrammyError, HttpError } from 'grammy';
import { config } from './config.js';
import { runInitialCollect, startScheduler, splitTelegram, type Notifier } from './scheduler.js';
import { handleUpdateText } from './bot/commands.js';

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
      for (const part of splitTelegram(reply)) {
        await ctx.reply(part, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
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
  console.log('[bot] scheduler aktif (rss 30m, ai 6h, digest 06:30 WIB, weekly Sen 09:00)');

  void bot.start({
    onStart: (me) => {
      console.log(`[bot] @${me.username} live sebagai ${me.first_name}`);
      void notify.send(`☀️ <b>ORACLE online</b>\n${bootMsg}`).catch(() => undefined);
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
