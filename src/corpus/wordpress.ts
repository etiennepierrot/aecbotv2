import type { SourceItem } from "./types.js";

/**
 * Client minimal de l'API REST WordPress du site du programme.
 * - PDF : médias de type application/pdf (livrets, plans, programme…)
 * - HTML : pages et articles dont l'URL est sous /programme/
 */
export class WordPressSource {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async listItems(): Promise<SourceItem[]> {
    const [pdfs, pages, posts] = await Promise.all([
      this.listAll<WpMedia>("media", { mime_type: "application/pdf", _fields: "id,source_url,modified_gmt,title" }),
      this.listAll<WpPost>("pages", { _fields: "id,link,modified_gmt,title,content" }),
      this.listAll<WpPost>("posts", { _fields: "id,link,modified_gmt,title,content" }),
    ]);

    const items: SourceItem[] = pdfs.map((m) => ({
      id: `wp:media:${m.id}`,
      origin: "wordpress",
      kind: "pdf",
      title: decodeEntities(m.title.rendered),
      url: m.source_url,
      modified: toIso(m.modified_gmt),
    }));

    for (const [type, list] of [["page", pages], ["post", posts]] as const) {
      for (const p of list) {
        if (!isUnderProgramme(p.link)) continue;
        items.push({
          id: `wp:${type}:${p.id}`,
          origin: "wordpress",
          kind: "html",
          title: decodeEntities(p.title.rendered),
          url: p.link,
          modified: toIso(p.modified_gmt),
          inlineContent: p.content?.rendered ?? "",
        });
      }
    }
    return items;
  }

  async download(url: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(url, { headers: { "user-agent": USER_AGENT } });
    if (!res.ok) throw new Error(`Téléchargement impossible (${res.status}) : ${url}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async listAll<T>(endpoint: string, params: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const url = new URL(`/wp-json/wp/v2/${endpoint}`, this.baseUrl);
      for (const [k, v] of Object.entries({ ...params, per_page: "100", page: String(page) })) {
        url.searchParams.set(k, v);
      }
      const res = await this.fetchImpl(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
      // WordPress répond 400 quand on dépasse la dernière page.
      if (res.status === 400 && page > 1) break;
      if (!res.ok) throw new Error(`API WordPress ${endpoint} : HTTP ${res.status}`);
      out.push(...((await res.json()) as T[]));
      const totalPages = Number(res.headers.get("x-wp-totalpages") ?? "1");
      if (page >= totalPages) break;
    }
    return out;
  }
}

const USER_AGENT = "AECBot/0.1 (initiative militante non officielle)";

interface WpMedia {
  id: number;
  source_url: string;
  modified_gmt: string;
  title: { rendered: string };
}

interface WpPost {
  id: number;
  link: string;
  modified_gmt: string;
  title: { rendered: string };
  content?: { rendered: string };
}

export function isUnderProgramme(link: string): boolean {
  try {
    return new URL(link).pathname.startsWith("/programme/");
  } catch {
    return false;
  }
}

/** WordPress renvoie modified_gmt sans fuseau. */
function toIso(gmt: string): string {
  return new Date(gmt.endsWith("Z") ? gmt : `${gmt}Z`).toISOString();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&(rsquo|lsquo);/g, "’")
    .replace(/&(rdquo|ldquo);/g, "\"")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&hellip;/g, "…")
    .trim();
}
