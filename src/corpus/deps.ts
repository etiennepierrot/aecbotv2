import { PgVector } from "@mastra/pg";
import { config, EMBEDDING_DIMENSION } from "../config.js";
import { embedderFromKeys, type Embedder } from "./embed.js";
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
}

let retrieval: RetrievalDeps | undefined;

/** Dépendances de la recherche : même modèle d'embeddings que l'ingestion. */
export async function retrievalDeps(): Promise<RetrievalDeps> {
  if (!retrieval) {
    retrieval = { embedder: embedderFromEnv(), vector: pgVector() };
  }
  return retrieval;
}

export function setRetrievalDeps(d: RetrievalDeps): void {
  retrieval = d;
}

function embedderFromEnv(): Embedder {
  const cfg = config();
  return embedderFromKeys({ mistral: cfg.MISTRAL_API_KEY, openrouter: cfg.OPENROUTER_API_KEY });
}
