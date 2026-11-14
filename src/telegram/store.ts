import type { Pool } from "pg";

export interface HitResult {
  allowed: boolean;
  count: number;
  resetAt: Date;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Données du bot, toutes indexées par pseudonyme (jamais par identifiant Telegram) :
 * compteur de questions par heure et mémoire de conversation pour les questions de suite.
 */
export class BotStore {
  private ready?: Promise<void>;

  constructor(private readonly pool: Pool) {}

  init(): Promise<void> {
    this.ready ??= this.pool
      .query(`
        CREATE TABLE IF NOT EXISTS aec_rate_limit (
          pseudo       text NOT NULL,
          window_start timestamptz NOT NULL,
          count        integer NOT NULL,
          PRIMARY KEY (pseudo, window_start)
        );
        CREATE TABLE IF NOT EXISTS aec_conversations (
          id         bigserial PRIMARY KEY,
          pseudo     text NOT NULL,
          role       text NOT NULL CHECK (role IN ('user', 'assistant')),
          content    text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS aec_conversations_pseudo ON aec_conversations (pseudo, created_at DESC);
        -- Trace Mastra de la réponse : relie un vote à sa trace, et permet de l'effacer avec /oublier.
        ALTER TABLE aec_conversations ADD COLUMN IF NOT EXISTS trace_id text;
        ALTER TABLE aec_conversations ADD COLUMN IF NOT EXISTS span_id text;
        CREATE INDEX IF NOT EXISTS aec_conversations_trace ON aec_conversations (trace_id) WHERE trace_id IS NOT NULL;
        -- Après un 👎, la question « qu'est-ce qui n'allait pas ? » en attente de réponse.
        CREATE TABLE IF NOT EXISTS aec_feedback_prompts (
          pseudo            text NOT NULL,
          prompt_message_id bigint NOT NULL,
          trace_id          text NOT NULL,
          created_at        timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (pseudo, prompt_message_id)
        );
      `)
      .then(() => undefined);
    return this.ready;
  }

  /** Compte une question dans la fenêtre de l'heure en cours (atomique, sûr à plusieurs instances). */
  async hit(pseudo: string, limit: number, now = new Date()): Promise<HitResult> {
    await this.init();
    const windowStart = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    const { rows } = await this.pool.query(
      `INSERT INTO aec_rate_limit (pseudo, window_start, count) VALUES ($1, $2, 1)
       ON CONFLICT (pseudo, window_start) DO UPDATE SET count = aec_rate_limit.count + 1
       RETURNING count`,
      [pseudo, windowStart],
    );
    const count = rows[0].count as number;
    return { allowed: count <= limit, count, resetAt: new Date(windowStart.getTime() + 3_600_000) };
  }

  /** Derniers échanges récents, du plus ancien au plus récent. */
  async history(pseudo: string, { maxMessages = 6, maxAgeHours = 24 } = {}): Promise<HistoryMessage[]> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT role, content FROM (
         SELECT role, content, id FROM aec_conversations
          WHERE pseudo = $1 AND created_at > now() - make_interval(hours => $2)
          ORDER BY id DESC LIMIT $3
       ) recent ORDER BY id ASC`,
      [pseudo, maxAgeHours, maxMessages],
    );
    return rows as HistoryMessage[];
  }

  async append(pseudo: string, question: string, answer: string, traceId?: string, spanId?: string): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO aec_conversations (pseudo, role, content, trace_id, span_id)
       VALUES ($1, 'user', $2, NULL, NULL), ($1, 'assistant', $3, $4, $5)`,
      [pseudo, question, answer, traceId ?? null, spanId ?? null],
    );
  }

  /**
   * La réponse de cette trace a-t-elle bien été donnée à cette personne ? (le bouton vient du client)
   * Renvoie le span racine de la réponse, ou undefined si ce n'est pas le cas.
   */
  async answerOf(pseudo: string, traceId: string): Promise<{ spanId: string | null } | undefined> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT span_id FROM aec_conversations WHERE pseudo = $1 AND trace_id = $2 LIMIT 1`,
      [pseudo, traceId],
    );
    return rows[0] ? { spanId: rows[0].span_id } : undefined;
  }

  async ownsTrace(pseudo: string, traceId: string): Promise<boolean> {
    return (await this.answerOf(pseudo, traceId)) !== undefined;
  }

  async traceIds(pseudo: string): Promise<string[]> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT DISTINCT trace_id FROM aec_conversations WHERE pseudo = $1 AND trace_id IS NOT NULL`,
      [pseudo],
    );
    return rows.map((r) => r.trace_id as string);
  }

  async addFeedbackPrompt(pseudo: string, promptMessageId: number, traceId: string): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO aec_feedback_prompts (pseudo, prompt_message_id, trace_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [pseudo, promptMessageId, traceId],
    );
  }

  /** Consomme la demande de commentaire à laquelle ce message répond, s'il y en a une. */
  async takeFeedbackPrompt(
    pseudo: string,
    promptMessageId: number,
  ): Promise<{ traceId: string; spanId: string | null } | undefined> {
    await this.init();
    const { rows } = await this.pool.query(
      `DELETE FROM aec_feedback_prompts WHERE pseudo = $1 AND prompt_message_id = $2
         AND created_at > now() - interval '1 day'
       RETURNING trace_id`,
      [pseudo, promptMessageId],
    );
    const traceId = rows[0]?.trace_id as string | undefined;
    if (!traceId) return undefined;
    return { traceId, spanId: (await this.answerOf(pseudo, traceId))?.spanId ?? null };
  }

  /** Droit à l'effacement : /oublier. */
  async forget(pseudo: string): Promise<number> {
    await this.init();
    const a = await this.pool.query(`DELETE FROM aec_conversations WHERE pseudo = $1`, [pseudo]);
    await this.pool.query(`DELETE FROM aec_rate_limit WHERE pseudo = $1`, [pseudo]);
    await this.pool.query(`DELETE FROM aec_feedback_prompts WHERE pseudo = $1`, [pseudo]);
    return a.rowCount ?? 0;
  }

  /** Purge nocturne : conversations plus vieilles que `days`, compteurs expirés. */
  async purge(days: number): Promise<{ messages: number; compteurs: number }> {
    await this.init();
    const m = await this.pool.query(
      `DELETE FROM aec_conversations WHERE created_at < now() - make_interval(days => $1)`,
      [days],
    );
    const c = await this.pool.query(`DELETE FROM aec_rate_limit WHERE window_start < now() - interval '2 hours'`);
    await this.pool.query(`DELETE FROM aec_feedback_prompts WHERE created_at < now() - interval '1 day'`);
    return { messages: m.rowCount ?? 0, compteurs: c.rowCount ?? 0 };
  }
}
