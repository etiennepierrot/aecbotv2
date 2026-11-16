import type { PgVector } from "@mastra/pg";
import { PASSAGES_INDEX } from "../config.js";

/**
 * Recherche plein texte (Postgres, dictionnaire français), complément de la recherche
 * vectorielle : un mot précis (« corrida », « OTAN ») cité une seule fois dans une liste
 * se perd dans l'embedding d'un passage de 1 200 caractères, pas dans un index de mots.
 *
 * Le texte indexé est la section (livre) puis le passage : l'expression doit rester
 * identique à celle de l'index GIN créé par CorpusStore.init(), sinon l'index n'est pas utilisé.
 */
export const TSV_EXPR = `to_tsvector('french', coalesce(metadata->>'section', '') || ' ' || coalesce(metadata->>'text', ''))`;

/**
 * Mots vides du français. Le dictionnaire de Postgres en oublie (« les » devient « le » et
 * correspond à tous les passages) : on les retire avant la requête.
 */
const MOTS_VIDES = [
  "les", "des", "aux", "une", "uns", "unes", "que", "qui", "quoi", "dont", "sur", "sous", "dans", "par", "entre",
  "elle", "elles", "ils", "eux", "lui", "leur", "leurs", "nous", "vous", "son", "sa", "ses", "mon", "mes", "ton",
  "tes", "notre", "nos", "votre", "vos", "cette", "ces", "cet", "celle", "celles", "celui", "ceux", "mais", "donc",
  "car", "pas", "plus", "moins", "tres", "aussi", "bien", "encore", "deja", "ete", "etre", "avoir", "ont", "avait",
  "peut", "peuvent", "quand", "lors", "alors", "ainsi", "comme", "chez", "vers", "depuis", "pendant", "selon",
];

/**
 * Mots qui figurent dans presque toutes les questions et presque tous les passages : ils ne
 * distinguent rien.
 */
const MOTS_DU_DOMAINE = new Set([
  ...MOTS_VIDES,
  "programme", "programmes", "prevoit", "prevoir", "prevu", "prevue", "propose", "proposer", "proposition",
  "propositions", "mesure", "mesures", "avenir", "commun", "melenchon", "jean", "luc", "lfi", "insoumise",
  "insoumis", "france", "francais", "faire", "fait", "veut", "veulent", "vouloir", "quoi", "quelle", "quelles",
  "quel", "quels", "position", "dit", "dire", "disait", "plan", "livret", "livrets", "comment", "pourra",
  "pourrait", "sera", "seront", "serait", "est", "sont", "touche", "parle", "concerne", "compte", "chose",
  "edition", "version", "nouveau", "nouvelle", "contre", "pour", "avec", "sans", "tous", "tout", "toutes",
]);

const sansAccents = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "");

/** Les mots de la question qui valent d'être cherchés tels quels (3 lettres au moins). */
export function termesRecherche(question: string): string[] {
  const mots = question
    .toLowerCase()
    .replace(/['’]/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((m) => m.length >= 3 && !MOTS_DU_DOMAINE.has(sansAccents(m)));
  return [...new Set(mots)];
}

export interface TextHit {
  id: string;
  /** Similarité cosinus avec la requête : le même score que la recherche vectorielle. */
  score: number;
  metadata: Record<string, unknown>;
}

export type TextSearch = (args: {
  requete: string;
  queryVector: number[];
  corpus: string;
  categories?: string[];
  topK: number;
}) => Promise<TextHit[]>;

/**
 * Passages qui contiennent au moins un des mots de la requête (OU), classés par pertinence
 * plein texte. Chacun reçoit aussi sa similarité cosinus, pour que `score` garde partout le
 * même sens (seuils, journaux, évals).
 */
export function textSearchFrom(vector: Pick<PgVector, "pool">): TextSearch {
  return async ({ requete, queryVector, corpus, categories, topK }) => {
    const termes = termesRecherche(requete);
    if (termes.length === 0) return [];
    const params: unknown[] = [termes.join(" | "), `[${queryVector.join(",")}]`, corpus, topK];
    let filtreCategorie = "";
    if (categories?.length) {
      params.push(categories);
      filtreCategorie = `AND metadata->>'category' = ANY($5)`;
    }
    const { rows } = await vector.pool.query(
      `SELECT vector_id AS id, metadata, 1 - (embedding <=> $2::vector) AS score
         FROM ${PASSAGES_INDEX}, to_tsquery('french', $1) q
        WHERE ${TSV_EXPR} @@ q AND metadata->>'corpus' = $3 ${filtreCategorie}
        ORDER BY ts_rank(${TSV_EXPR}, q, 1) DESC
        LIMIT $4`,
      params,
    );
    return rows.map((r) => ({ id: r.id as string, score: Number(r.score), metadata: r.metadata as Record<string, unknown> }));
  };
}
