import { config } from './config.js';

export interface LlmResult {
  content: string;
  provider: string;
  model: string;
  elapsedMs: number;
}

interface ChatChoiceMsg {
  content?: string | null;
  reasoning_content?: string | null;
}

interface ChatResponse {
  choices?: { message?: ChatChoiceMsg }[];
}

function tolerantParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(text.slice(s, e + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function llmChat(
  messages: { role: string; content: string }[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<LlmResult> {
  const errors: string[] = [];
  // Reasoning models (glm-5.3) menghabiskan token di reasoning_content — budget kecil bikin content=null.
  const maxTokens = opts.maxTokens ?? 8192;
  for (const p of config.llmChain) {
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 180_000);
      const r = await fetch(`${p.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({
          model: p.model,
          messages,
          max_tokens: maxTokens,
          temperature: opts.temperature ?? 0.7,
        }),
        signal: ctrl.signal,
      });
      const raw = await r.text();
      clearTimeout(to);
      const j = tolerantParse(raw) as ChatResponse | null;
      const msg = j?.choices?.[0]?.message;
      // reasoning model: content bisa null kalau max_tokens kehabisan — fallback ke reasoning_content
      const content = msg?.content?.trim() || msg?.reasoning_content?.trim();
      if (r.ok && content && content.trim()) {
        return { content: content.trim(), provider: p.name, model: p.model, elapsedMs: Date.now() - t0 };
      }
      errors.push(`${p.name}: HTTP ${r.status} ${(raw || '').slice(0, 180)}`);
    } catch (e) {
      errors.push(`${p.name}: ${(e as Error).message}`);
    }
  }
  throw new Error(`All LLM providers failed: ${errors.join(' | ')}`);
}

export async function llmListModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const r = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  const j = (await r.json()) as { data?: { id: string }[] };
  return (j.data ?? []).map((m) => m.id);
}
