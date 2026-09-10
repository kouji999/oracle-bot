export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)));
}

async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    return await p(ctrl.signal);
  } finally {
    clearTimeout(to);
  }
}

export async function ddgSearch(query: string, max = 5): Promise<SearchHit[]> {
  const strategies: (() => Promise<SearchHit[]>)[] = [
    async () => {
      const r = await withTimeout(
        (signal) => fetch('https://html.duckduckgo.com/html/', {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            accept: 'text/html',
          },
          body: new URLSearchParams({ q: query }).toString(),
          signal,
        }),
        15_000,
      );
      const html = await r.text();
      const hits: SearchHit[] = [];
      const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      const links: { url: string; title: string }[] = [];
      const snippets: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(html)) !== null) {
        links.push({ url: decodeEntities(m[1]), title: decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim() });
      }
      while ((m = snippetRe.exec(html)) !== null) {
        snippets.push(decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim());
      }
      for (let i = 0; i < links.length && hits.length < max; i++) {
        const u = links[i].url;
        const uddg = u.match(/uddg=([^&]+)/);
        const url = uddg ? decodeURIComponent(uddg[1]) : u;
        if (url.startsWith('http')) hits.push({ title: links[i].title, url, snippet: snippets[i] ?? '' });
      }
      return hits;
    },
    async () => {
      const r = await withTimeout(
        (signal) => fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          },
          signal,
        }),
        15_000,
      );
      const html = await r.text();
      const hits: SearchHit[] = [];
      const re = /<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null && hits.length < max) {
        const uddg = m[1].match(/uddg=([^&]+)/);
        const url = uddg ? decodeURIComponent(uddg[1]) : m[1];
        const title = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim();
        if (url.startsWith('http') && title && !url.includes('duckduckgo.com')) {
          hits.push({ title, url, snippet: '' });
        }
      }
      return hits;
    },
  ];

  for (const s of strategies) {
    try {
      const hits = await s();
      if (hits.length > 0) return hits;
    } catch {
      // try next strategy
    }
  }
  return [];
}
