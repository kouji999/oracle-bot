import { handleUpdateText } from './bot/commands.js';
import { buildMorningDigest } from './digest.js';
import { marketSnapshot, formatMarketLines } from './collectors/market.js';
import { collectRss } from './collectors/rss.js';
import { scanAiProviders } from './collectors/ai.js';
import { scanX } from './collectors/xai.js';
import { syncFreeLlmProviders } from './collectors/freellm.js';
import { ddgSearch } from './search.js';

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const chatId = 'cli-test';
  const t0 = Date.now();
  let out = '';

  switch (cmd) {
    case 'rss': {
      const r = await collectRss();
      out = r.perFeed.map((f) => `${f.ok ? 'OK ' : 'ERR'} ${f.source}: ${f.items} new${f.error ? ` (${f.error})` : ''}`).join('\n');
      out += `\n\nSample baru:\n${r.newArticles.slice(0, 5).map((a) => `• [${a.source}] ${a.title}\n  ${a.url}`).join('\n')}`;
      break;
    }
    case 'ai': {
      const r = await scanAiProviders();
      out = `free models: ${r.freeModelsTotal}\nnew: ${r.newModels.map((m) => m.id).join(', ') || '-'}\ngh: ${r.ghUpdates.length} updates${r.errors.length ? `\nerrors: ${r.errors.join(' | ')}` : ''}`;
      break;
    }
    case 'prov': {
      if (args.length) {
        out = (await handleUpdateText(chatId, `/prov ${args.join(' ')}`)) ?? '';
      } else {
        const s = await syncFreeLlmProviders();
        out = `sync: ${s.ok ? 'ok' : `FAILED ${s.error}`} · total: ${s.total} · events: ${s.events.length ? s.events.map((e: { name: string; type: string }) => `${e.name}(${e.type})`).join(', ') : '0'}`;
      }
      break;
    }
    case 'xai': {
      const s = await scanX();
      out = `new: ${s.newPosts.length}\n${s.newPosts.slice(0, 8).map((p: { title: string; url: string }) => `- ${p.title}\n  ${p.url}`).join('\n')}${s.errors.length ? `\nerrors: ${s.errors.join(' | ')}` : ''}`;
      break;
    }
    case 'market': {
      const s = await marketSnapshot();
      out = `${formatMarketLines(s) || '(no data)'}\nerrors: ${s.errors.join(' | ') || '-'}`;
      break;
    }
    case 'ddg': {
      const hits = await ddgSearch(args.join(' ') || 'IHSG hari ini', 6);
      out = hits.length ? hits.map((h) => `• ${h.title}\n  ${h.url}\n  ${h.snippet.slice(0, 150)}`).join('\n') : 'NO HITS';
      break;
    }
    case 'digest': {
      out = await buildMorningDigest();
      break;
    }
    case 'ask': {
      out = (await handleUpdateText(chatId, `/ask ${args.join(' ') || 'apa itu IHSG, singkat'}`)) ?? '';
      break;
    }
    case 'help':
    case 'news':
    case 'newsid':
    case 'aifree':
    case 'status':
    case 'price': {
      out = (await handleUpdateText(chatId, cmd === 'help' ? '/help' : `/${cmd}`)) ?? '';
      break;
    }
    default:
      out = 'Usage: npm run cli -- <rss|ai|prov|xai|market|ddg|digest|ask|help|news|newsid|aifree|price|status> [args]';
  }

  console.log(`\n===== ${cmd} (${Date.now() - t0}ms) =====\n`);
  console.log(out);
  process.exit(0);
}

void main().catch((e) => {
  console.error('CLI FAIL:', e);
  process.exit(1);
});
