import { PgVector } from "@mastra/pg";
import { config, EMBEDDING_DIMENSION, PASSAGES_INDEX } from "../config.js";
import { mistralEmbedder, type Embedder } from "./embed.js";
import { textSearchFrom, type TextSearch } from "./fulltext.js";
import { CompositeSource, EDITION_2022, StaticSource } from "./sources.js";
import { CorpusStore } from "./store.js";
import { WordPressSource } from "./wordpress.js";

export interface IngestDeps {
  source: Pick<WordPressSource, "listItems" | "download">;
  embedder: Embedder;
  store: CorpusStore;
}

let vector: PgVector | undefined;

/** Instance pgvector partagée par Mastra, l'ingestion et (étape 2) l'outil de recherche. */
export function pgVector(): PgVector {
  vector ??= new PgVector({ id: "aec-vector", connectionString: config().DATABASE_URL });
  return vector;
}

let deps: IngestDeps | undefined;
let ready: Promise<void> | undefined;

/** Dépendances de l'ingestion, construites depuis l'environnement (remplaçables en test). */
export async function ingestDeps(): Promise<IngestDeps> {
  if (!deps) {
    const cfg = config();
    deps = {
      source: (() => {
        const wp = new WordPressSource(cfg.WP_BASE_URL);
        return new CompositeSource([wp, new StaticSource(EDITION_2022)], wp);
      })(),
      embedder: embedderFromEnv(),
      store: new CorpusStore(pgVector(), EMBEDDING_DIMENSION),
    };
  }
  ready ??= deps.store.init();
  await ready;
  return deps;
}

export function setIngestDeps(d: IngestDeps): void {
  deps = d;
  ready = undefined;
}

export interface RetrievalDeps {
  embedder: Embedder;
  vector: Pick<PgVector, "query">;
  /** Tous les passages d'une page, dans l'ordre (absent : pas d'élargissement à la page). */
  pageChunks?: (docId: string, page: number) => Promise<string[]>;
  /** Recherche plein texte, fusionnée avec la vectorielle (absent : recherche vectorielle seule). */
  textSearch?: TextSearch;
}

let retrieval: RetrievalDeps | undefined;

/** Dépendances de la recherche : même modèle d'embeddings que l'ingestion. */
export async function retrievalDeps(): Promise<RetrievalDeps> {
  if (!retrieval) {
    const vector = pgVector();
    retrieval = { embedder: embedderFromEnv(), vector, pageChunks: pageChunksFrom(vector), textSearch: textSearchFrom(vector) };
  }
  return retrieval;
}

/** Les passages d'une page PDF, dans l'ordre du découpage. */
export function pageChunksFrom(vector: PgVector): NonNullable<RetrievalDeps["pageChunks"]> {
  return async (docId, page) => {
    const { rows } = await vector.pool.query(
      `SELECT metadata->>'text' AS text FROM ${PASSAGES_INDEX}
        WHERE metadata->>'docId' = $1 AND metadata->>'page' = $2
        ORDER BY (split_part(vector_id, '#', 3))::int`,
      [docId, String(page)],
    );
    return rows.map((r) => r.text as string);
  };
}

export function setRetrievalDeps(d: RetrievalDeps): void {
  retrieval = d;
}

function embedderFromEnv(): Embedder {
  return mistralEmbedder(config().MISTRAL_API_KEY);
}
