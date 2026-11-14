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

  async append(pseudo: string, question: string, answer: string): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO aec_conversations (pseudo, role, content) VALUES ($1, 'user', $2), ($1, 'assistant', $3)`,
      [pseudo, question, answer],
    );
  }

  /** Droit à l'effacement : /oublier. */
  async forget(pseudo: string): Promise<number> {
    await this.init();
    const a = await this.pool.query(`DELETE FROM aec_conversations WHERE pseudo = $1`, [pseudo]);
    await this.pool.query(`DELETE FROM aec_rate_limit WHERE pseudo = $1`, [pseudo]);
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
    return { messages: m.rowCount ?? 0, compteurs: c.rowCount ?? 0 };
  }
}
