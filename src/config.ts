import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const envFile = resolve(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export interface LlmProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const config = {
  root,
  dataDir: resolve(root, 'data'),
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  ownerChatId: process.env.OWNER_CHAT_ID ?? '',
  allowedChatIds: (process.env.ALLOWED_CHAT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  llmChain: [
    {
      name: 'tokenrouter',
      baseUrl: process.env.TOKENROUTER_BASE_URL ?? 'https://api.tokenrouter.com/v1',
      apiKey: process.env.TOKENROUTER_API_KEY ?? '',
      model: process.env.TOKENROUTER_MODEL ?? 'z-ai/glm-5.3-free',
    },
    {
      name: 'b.ai',
      baseUrl: process.env.BAI_BASE_URL ?? 'https://api.b.ai/v1',
      apiKey: process.env.BAI_API_KEY ?? '',
      model: process.env.BAI_MODEL ?? 'qwen3.8-flash',
    },
    {
      name: 'devstack',
      baseUrl: process.env.DEVSTACK_BASE_URL ?? 'http://127.0.0.1:20128/v1',
      apiKey: process.env.DEVSTACK_API_KEY ?? '',
      model: process.env.DEVSTACK_MODEL ?? '9router/Dev-Stack',
    },
  ].filter((p) => p.apiKey),
  coingeckoKey: process.env.COINGECKO_DEMO_KEY ?? '',
  twelvedataKey: process.env.TWELVEDATA_API_KEY ?? '',
  x: {
    authToken: process.env.X_AUTH_TOKEN ?? '',
    ct0: process.env.X_CT0 ?? '',
    handle: process.env.X_HANDLE ?? 'HidayatRal45222',
  },
};

export function assertLlm(): void {
  if (config.llmChain.length === 0) {
    throw new Error('No LLM provider configured — check TOKENROUTER_API_KEY / BAI_API_KEY in .env');
  }
}
