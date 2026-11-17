import { config, PASSAGES_INDEX } from "../config.js";
import { retrievalDeps } from "../corpus/deps.js";
import { CATEGORIES_PROGRAMME, type Category, type Corpus } from "../corpus/types.js";
import type { RetrievedPassage } from "./types.js";

export interface SearchParams {
  requete: string;
  /** Une édition précise, ou toutes celles de EDITIONS (par défaut). */
  edition?: Corpus | "toutes";
  /** Par défaut, toutes les catégories du programme : l'argumentaire n'en fait jamais partie. */
  categories?: Category[];
  /** Nombre de passages tirés de l'index, avant regroupement par page. */
  topK?: number;
  /** Élargir chaque passage à toute sa page (par défaut). L'éval de la recherche s'en passe. */
  elargir?: boolean;
}

/** Au-delà, le texte d'une page est coupé (une page A5 fait 1 500 à 3 000 caractères). */
const MAX_PAGE_CHARS = 6000;

/** Constante de la fusion par rangs (Reciprocal Rank Fusion) : 60 est la valeur d'usage. */
const RRF_K = 60;
/**
 * Passages trouvés par les mots seulement, ajoutés au plus par édition. La recherche plein
 * texte ne fait qu'ajouter : elle ne pousse jamais dehors un passage trouvé par le sens
 * (« cryptomonnaies » ne correspond à aucun mot de « crypto-actifs », seul le sens le relie).
 */
const MAX_PAR_MOTS = 3;

/**
 * Recherche hybride filtrée par édition, en deux temps :
 * 1. les passages les plus proches, avec une part réservée à chaque édition, pour que
 *    l'édition la plus récente ne soit pas noyée sous les nombreux livrets 2022. Dans chaque
 *    édition, la recherche plein texte (mots exacts : « corrida ») ajoute au plus MAX_PAR_MOTS
 *    passages à ceux de la recherche vectorielle, tous gardés ; l'ordre vient de la fusion par
 *    rangs, `score` reste la similarité cosinus ;
 * 2. chaque passage est élargi à toute sa page PDF (ou section du livre) : un chiffre
 *    (« SMIC à 1 600 € ») est souvent dans le passage voisin de celui qui a été trouvé.
 */
export async function searchPassages({
  requete,
  edition = "toutes",
  categories = CATEGORIES_PROGRAMME,
  topK = 10,
  elargir = true,
}: SearchParams): Promise<RetrievedPassage[]> {
  const { embedder, vector, pageChunks, textSearch } = await retrievalDeps();
  const [queryVector] = await embedder.embed([requete]);
  if (!queryVector) return [];

  const editions = edition === "toutes" ? config().EDITIONS : [edition];
  // Première édition (la plus récente) : 60 % des places ; les autres se partagent le reste.
  const quotas =
    editions.length === 1
      ? [topK]
      : editions.map((_, i) => (i === 0 ? Math.ceil(topK * 0.6) : Math.max(2, Math.floor((topK * 0.4) / (editions.length - 1)))));

  const batches = await Promise.all(
    editions.map(async (ed, i) => {
      const quota = quotas[i]!;
      const filter: Record<string, unknown> = { corpus: { $eq: ed } };
      if (categories.length) filter.category = { $in: categories };
      const [parSens, parMots] = await Promise.all([
        vector.query({ indexName: PASSAGES_INDEX, queryVector, topK: quota, filter: filter as never }),
        textSearch ? textSearch({ requete, queryVector, corpus: ed, categories, topK: quota }) : Promise.resolve([]),
      ]);
      return hybride(
        parSens.map((r) => toPassage(r.id, r.score, (r.metadata ?? {}) as Record<string, unknown>)),
        parMots.map((r) => toPassage(r.id, r.score, r.metadata)),
      );
    }),
  );

  // Les éditions s'entrelacent selon leur rang fusionné, pas selon le score cosinus seul.
  const hits = batches.flat().sort((a, b) => b.fused - a.fused).map(({ fused: _f, ...p }) => p);
  if (!elargir) return groupByPage(hits);
  if (!pageChunks) return hits;

  const byPage = groupByPage(hits);
  await Promise.all(
    byPage
      .filter((p) => p.page !== null)
      .map(async (p) => {
        const chunks = await pageChunks(p.docId, p.page!);
        if (chunks.length) p.text = joinChunks(chunks).slice(0, MAX_PAGE_CHARS);
      }),
  );
  return byPage;
}

/**
 * Fusion par rangs : 1/(60 + rang) dans chaque liste, additionné. Un passage trouvé par les
 * deux recherches passe devant ; sinon les deux listes s'entrelacent.
 */
export function fuse(...listes: RetrievedPassage[][]): (RetrievedPassage & { fused: number })[] {
  const byId = new Map<string, RetrievedPassage & { fused: number }>();
  for (const liste of listes) {
    liste.forEach((p, rang) => {
      const known = byId.get(p.id);
      if (known) known.fused += 1 / (RRF_K + rang + 1);
      else byId.set(p.id, { ...p, fused: 1 / (RRF_K + rang + 1) });
    });
  }
  return [...byId.values()].sort((a, b) => b.fused - a.fused || b.score - a.score);
}

/**
 * Tous les passages trouvés par le sens, plus au plus MAX_PAR_MOTS trouvés par les mots seuls,
 * dans l'ordre de la fusion par rangs. Rien de ce que trouve la recherche vectorielle ne disparaît.
 */
export function hybride(parSens: RetrievedPassage[], parMots: RetrievedPassage[], maxParMots = MAX_PAR_MOTS) {
  const sens = new Set(parSens.map((p) => p.id));
  const ajouts = parMots.filter((p) => !sens.has(p.id)).slice(0, maxParMots);
  const gardes = new Set([...sens, ...ajouts.map((p) => p.id)]);
  return fuse(parSens, parMots).filter((p) => gardes.has(p.id));
}

/** Un seul passage par (document, page), le mieux classé, dans l'ordre reçu. */
function groupByPage(hits: RetrievedPassage[]): RetrievedPassage[] {
  const byPage = new Map<string, RetrievedPassage>();
  for (const h of hits) {
    const key = h.page === null ? h.id : `${h.docId}#p${h.page}`;
    if (byPage.has(key)) continue;
    byPage.set(key, { ...h, id: key });
  }
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
    section: typeof m.section === "string" ? m.section : null,
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
