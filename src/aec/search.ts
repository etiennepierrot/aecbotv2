import { config, PASSAGES_INDEX } from "../config.js";
import { retrievalDeps } from "../corpus/deps.js";
import type { Category, Corpus } from "../corpus/types.js";
import type { RetrievedPassage } from "./types.js";

export interface SearchParams {
  requete: string;
  /** Une édition précise, ou toutes celles de EDITIONS (par défaut). */
  edition?: Corpus | "toutes";
  categories?: Category[];
  /** Nombre de passages tirés de l'index, avant regroupement par page. */
  topK?: number;
}

/** Au-delà, le texte d'une page est coupé (une page A5 fait 1 500 à 3 000 caractères). */
const MAX_PAGE_CHARS = 6000;

/**
 * Recherche vectorielle filtrée par édition, en deux temps :
 * 1. les passages les plus proches, avec une part réservée à chaque édition, pour que
 *    l'édition la plus récente ne soit pas noyée sous les nombreux livrets 2022 ;
 * 2. chaque passage est élargi à toute sa page PDF : un chiffre (« SMIC à 1 600 € »)
 *    est souvent dans le passage voisin de celui qui a été trouvé.
 */
export async function searchPassages({
  requete,
  edition = "toutes",
  categories,
  topK = 10,
}: SearchParams): Promise<RetrievedPassage[]> {
  const { embedder, vector, pageChunks } = await retrievalDeps();
  const [queryVector] = await embedder.embed([requete]);
  if (!queryVector) return [];

  const editions = edition === "toutes" ? config().EDITIONS : [edition];
  // Première édition (la plus récente) : 60 % des places ; les autres se partagent le reste.
  const quotas =
    editions.length === 1
      ? [topK]
      : editions.map((_, i) => (i === 0 ? Math.ceil(topK * 0.6) : Math.max(2, Math.floor((topK * 0.4) / (editions.length - 1)))));

  const batches = await Promise.all(
    editions.map((ed, i) => {
      const filter: Record<string, unknown> = { corpus: { $eq: ed } };
      if (categories?.length) filter.category = { $in: categories };
      return vector.query({ indexName: PASSAGES_INDEX, queryVector, topK: quotas[i]!, filter: filter as never });
    }),
  );

  const hits = batches.flat().map((r) => toPassage(r.id, r.score, (r.metadata ?? {}) as Record<string, unknown>));
  hits.sort((a, b) => b.score - a.score);
  if (!pageChunks) return hits;

  // Regroupement par page : un seul passage par (document, page), avec le texte complet.
  const byPage = new Map<string, RetrievedPassage>();
  for (const h of hits) {
    const key = h.page === null ? h.id : `${h.docId}#p${h.page}`;
    if (byPage.has(key)) continue;
    byPage.set(key, { ...h, id: key });
  }
  await Promise.all(
    [...byPage.values()]
      .filter((p) => p.page !== null)
      .map(async (p) => {
        const chunks = await pageChunks(p.docId, p.page!);
        if (chunks.length) p.text = joinChunks(chunks).slice(0, MAX_PAGE_CHARS);
      }),
  );
  return [...byPage.values()];
}

function toPassage(id: string, score: number, m: Record<string, unknown>): RetrievedPassage {
  return {
    id,
    score,
    docId: String(m.docId),
    title: String(m.title),
    url: String(m.url),
    page: typeof m.page === "number" ? m.page : null,
    category: m.category as Category,
    corpus: m.corpus as Corpus,
    provisional: m.provisional === true,
    text: String(m.text ?? ""),
  };
}

/** Recolle les passages d'une page en retirant le chevauchement du découpage. */
export function joinChunks(chunks: string[]): string {
  let out = chunks[0] ?? "";
  for (const next of chunks.slice(1)) {
    let overlap = 0;
    for (let k = Math.min(300, next.length, out.length); k >= 20; k--) {
      if (out.endsWith(next.slice(0, k))) {
        overlap = k;
        break;
      }
    }
    out += (overlap ? "" : "\n") + next.slice(overlap);
  }
  return out;
}
