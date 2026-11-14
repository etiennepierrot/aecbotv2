import { config, PASSAGES_INDEX } from "../config.js";
import { retrievalDeps } from "../corpus/deps.js";
import type { Category, Corpus } from "../corpus/types.js";
import type { RetrievedPassage } from "./types.js";

export interface SearchParams {
  requete: string;
  /** Une édition précise, ou toutes celles de EDITIONS (par défaut). */
  edition?: Corpus | "toutes";
  categories?: Category[];
  topK?: number;
}

/** Recherche vectorielle filtrée par édition du programme (EDITIONS par défaut). */
export async function searchPassages({
  requete,
  edition = "toutes",
  categories,
  topK = 8,
}: SearchParams): Promise<RetrievedPassage[]> {
  const { embedder, vector } = await retrievalDeps();
  const [queryVector] = await embedder.embed([requete]);
  if (!queryVector) return [];

  const editions = edition === "toutes" ? config().EDITIONS : [edition];
  const filter: Record<string, unknown> = {
    corpus: editions.length === 1 ? { $eq: editions[0] } : { $in: editions },
  };
  if (categories?.length) filter.category = { $in: categories };

  const results = await vector.query({ indexName: PASSAGES_INDEX, queryVector, topK, filter: filter as never });
  return results.map((r) => {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      score: r.score,
      docId: String(m.docId),
      title: String(m.title),
      url: String(m.url),
      page: typeof m.page === "number" ? m.page : null,
      category: m.category as Category,
      corpus: m.corpus as Corpus,
      provisional: m.provisional === true,
      text: String(m.text ?? ""),
    };
  });
}
