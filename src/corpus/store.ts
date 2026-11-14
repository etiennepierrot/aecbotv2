import type { PgVector } from "@mastra/pg";
import { PASSAGES_INDEX } from "../config.js";
import type { Passage } from "./chunk.js";
import type { Category, Classification, SourceItem } from "./types.js";

export interface DocumentRow {
  id: string;
  origin: string;
  title: string;
  url: string;
  modified: string;
  category: Category;
  included: boolean;
  reason: string;
  pages: number;
  passages: number;
  contentHash: string | null;
}

/**
 * Registre des documents (une ligne par document vu, inclus ou écarté) et
 * index des passages dans pgvector. Le registre sert à la détection des
 * changements et, plus tard, à /docs et /supprimer.
 */
export class CorpusStore {
  constructor(
    private readonly vector: PgVector,
    private readonly dimension: number,
  ) {}

  private get pool() {
    return this.vector.pool;
  }

  async init(): Promise<void> {
    await this.vector.createIndex({
      indexName: PASSAGES_INDEX,
      dimension: this.dimension,
      metric: "cosine",
      indexConfig: { type: "hnsw" },
      metadataIndexes: ["docId", "corpus", "category"],
    });
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS aec_documents (
        id               text PRIMARY KEY,
        origin           text NOT NULL,
        kind             text NOT NULL,
        title            text NOT NULL,
        url              text NOT NULL,
        modified         timestamptz NOT NULL,
        category         text NOT NULL,
        corpus           text NOT NULL,
        included         boolean NOT NULL,
        reason           text NOT NULL DEFAULT '',
        pages            integer NOT NULL DEFAULT 0,
        characters       integer NOT NULL DEFAULT 0,
        passages         integer NOT NULL DEFAULT 0,
        content_hash     text,
        telegram_file_id text,
        added_by         text,
        indexed_at       timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS aec_documents_hash ON aec_documents (content_hash) WHERE included;
      -- Journal des ajouts et suppressions faits par l'équipe (qui, quoi, quand).
      CREATE TABLE IF NOT EXISTS aec_admin_log (
        id       bigserial PRIMARY KEY,
        at       timestamptz NOT NULL DEFAULT now(),
        who      text NOT NULL,
        action   text NOT NULL,
        doc_id   text,
        title    text,
        detail   text
      );
    `);
  }

  /** Documents ajoutés à la main, du plus récent au plus ancien. */
  async listManualDocuments(): Promise<
    { id: string; title: string; url: string; included: boolean; reason: string; passages: number; addedBy: string | null; indexedAt: string }[]
  > {
    const { rows } = await this.pool.query(
      `SELECT id, title, url, included, reason, passages, added_by AS "addedBy", indexed_at AS "indexedAt"
         FROM aec_documents WHERE origin = 'manuel' ORDER BY indexed_at DESC`,
    );
    return rows.map((r) => ({ ...r, indexedAt: new Date(r.indexedAt).toISOString() }));
  }

  async logAdmin(entry: { who: string; action: string; docId?: string; title?: string; detail?: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO aec_admin_log (who, action, doc_id, title, detail) VALUES ($1, $2, $3, $4, $5)`,
      [entry.who, entry.action, entry.docId ?? null, entry.title ?? null, entry.detail ?? null],
    );
  }

  async listDocuments(origin?: string): Promise<DocumentRow[]> {
    const { rows } = await this.pool.query(
      `SELECT id, origin, title, url, modified, category, included, reason, pages, passages,
              content_hash AS "contentHash"
         FROM aec_documents ${origin ? "WHERE origin = $1" : ""} ORDER BY id`,
      origin ? [origin] : [],
    );
    return rows.map((r) => ({ ...r, modified: new Date(r.modified).toISOString() }));
  }

  /** Document déjà inclus avec exactement le même texte, sous un autre identifiant. */
  async findDuplicate(id: string, contentHash: string): Promise<string | undefined> {
    const { rows } = await this.pool.query(
      `SELECT id FROM aec_documents WHERE included AND content_hash = $1 AND id <> $2 LIMIT 1`,
      [contentHash, id],
    );
    return rows[0]?.id;
  }

  /** Remplace tous les passages d'un document (upsert + suppression des anciens) et met à jour le registre. */
  async saveDocument(args: {
    item: SourceItem;
    cls: Classification;
    pages: number;
    characters: number;
    contentHash: string | null;
    passages: Passage[];
    vectors: number[][];
  }): Promise<void> {
    const { item, cls, passages, vectors } = args;
    if (passages.length > 0) {
      await this.vector.upsert({
        indexName: PASSAGES_INDEX,
        vectors,
        ids: passages.map((p) => p.id),
        metadata: passages.map((p) => p.metadata),
        deleteFilter: { docId: { $eq: item.id } },
      });
    } else {
      await this.deletePassages(item.id);
    }
    await this.pool.query(
      `INSERT INTO aec_documents
         (id, origin, kind, title, url, modified, category, corpus, included, reason,
          pages, characters, passages, content_hash, telegram_file_id, added_by, indexed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title, url = EXCLUDED.url, modified = EXCLUDED.modified,
         category = EXCLUDED.category, corpus = EXCLUDED.corpus, included = EXCLUDED.included,
         reason = EXCLUDED.reason, pages = EXCLUDED.pages, characters = EXCLUDED.characters,
         passages = EXCLUDED.passages, content_hash = EXCLUDED.content_hash,
         telegram_file_id = COALESCE(EXCLUDED.telegram_file_id, aec_documents.telegram_file_id),
         indexed_at = now()`,
      [
        item.id, item.origin, item.kind, item.title, item.url, item.modified,
        cls.category, cls.corpus, cls.included, cls.reason,
        args.pages, args.characters, passages.length, args.contentHash,
        item.telegramFileId ?? null, item.addedBy ?? null,
      ],
    );
  }

  /** Retire un document et tous ses passages de l'index. */
  async removeDocument(id: string): Promise<void> {
    await this.deletePassages(id);
    await this.pool.query(`DELETE FROM aec_documents WHERE id = $1`, [id]);
  }

  private async deletePassages(docId: string): Promise<void> {
    await this.vector.deleteVectors({ indexName: PASSAGES_INDEX, filter: { docId: { $eq: docId } } });
  }

  async countPassages(): Promise<number> {
    const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM ${PASSAGES_INDEX}`);
    return rows[0].n;
  }
}
