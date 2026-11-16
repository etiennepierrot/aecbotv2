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
/** Comment une réponse s'est passée : ni question, ni réponse, ni identifiant. */
export interface ReponseMeta {
  statut: "repondu" | "introuvable";
  origine: "question" | "suite";
  sources: number;
  citationsRejetees: number;
  phrasesRetirees: number;
  /** Réponse partielle contrôlée : « non » = devenue introuvable. */
  objet?: "oui" | "non" | "erreur";
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

export interface EchangeRapport {
  pseudo: string;
  question: string;
  answer: string;
  traceId?: string;
  meta?: ReponseMeta;
  createdAt: Date;
}

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
        -- Questions d'approfondissement proposées sous la réponse (boutons 1, 2, 3).
        ALTER TABLE aec_conversations ADD COLUMN IF NOT EXISTS suites jsonb;
        CREATE INDEX IF NOT EXISTS aec_conversations_trace ON aec_conversations (trace_id) WHERE trace_id IS NOT NULL;
        -- Comment la réponse s'est passée (statut, contrôles, jetons, durée) : sert au rapport journalier.
        ALTER TABLE aec_conversations ADD COLUMN IF NOT EXISTS meta jsonb;
        CREATE INDEX IF NOT EXISTS aec_conversations_created ON aec_conversations (created_at);
        -- Pannes et refus (limite horaire), comptés sans pseudonyme ni contenu.
        CREATE TABLE IF NOT EXISTS aec_incidents (
          id         bigserial PRIMARY KEY,
          kind       text NOT NULL CHECK (kind IN ('erreur', 'limite')),
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS aec_incidents_created ON aec_incidents (created_at);
        -- Après un 👎, la question « qu'est-ce qui n'allait pas ? » en attente de réponse.
        CREATE TABLE IF NOT EXISTS aec_feedback_prompts (
          pseudo            text NOT NULL,
          prompt_message_id bigint NOT NULL,
          trace_id          text NOT NULL,
          created_at        timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (pseudo, prompt_message_id)
        );
        -- Avis généraux sur le bot (/avis), sans lien avec une réponse.
        CREATE TABLE IF NOT EXISTS aec_avis (
          id         bigserial PRIMARY KEY,
          pseudo     text NOT NULL,
          texte      text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS aec_avis_created ON aec_avis (created_at DESC);
        -- Identifiant de discussion chiffré, pour que l'équipe puisse répondre.
        ALTER TABLE aec_avis ADD COLUMN IF NOT EXISTS chat_sealed text;
        -- Message de notification reçu par chaque membre de l'équipe → avis (pour y répondre).
        CREATE TABLE IF NOT EXISTS aec_avis_notifs (
          member_id  bigint NOT NULL,
          message_id bigint NOT NULL,
          avis_id    bigint NOT NULL REFERENCES aec_avis (id) ON DELETE CASCADE,
          PRIMARY KEY (member_id, message_id)
        );
        -- Après /avis sans texte, le message « dis-nous ce que tu en penses » en attente de réponse.
        CREATE TABLE IF NOT EXISTS aec_avis_prompts (
          pseudo            text NOT NULL,
          prompt_message_id bigint NOT NULL,
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

  async append(
    pseudo: string, question: string, answer: string, traceId?: string, spanId?: string, suites: string[] = [],
    meta?: ReponseMeta,
  ): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO aec_conversations (pseudo, role, content, trace_id, span_id, suites, meta)
       VALUES ($1, 'user', $2, NULL, NULL, NULL, NULL), ($1, 'assistant', $3, $4, $5, $6, $7)`,
      [
        pseudo, question, answer, traceId ?? null, spanId ?? null,
        suites.length ? JSON.stringify(suites) : null, meta ? JSON.stringify(meta) : null,
      ],
    );
  }

  /** Une panne ou un refus, compté sans pseudonyme ni contenu (rapport journalier). */
  async recordIncident(kind: "erreur" | "limite"): Promise<void> {
    await this.init();
    await this.pool.query(`INSERT INTO aec_incidents (kind) VALUES ($1)`, [kind]);
  }

  /** Les échanges d'une période, dans l'ordre, avec la manière dont chaque réponse s'est passée. */
  async echangesEntre(depuis: Date, jusqua: Date): Promise<EchangeRapport[]> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT a.pseudo, q.content AS question, a.content AS answer, a.trace_id, a.meta, a.created_at
         FROM aec_conversations a
         JOIN aec_conversations q ON q.id = a.id - 1 AND q.pseudo = a.pseudo AND q.role = 'user'
        WHERE a.role = 'assistant' AND a.created_at >= $1 AND a.created_at < $2
        ORDER BY a.id`,
      [depuis, jusqua],
    );
    return rows.map((r) => ({
      pseudo: r.pseudo as string,
      question: r.question as string,
      answer: r.answer as string,
      traceId: (r.trace_id as string | null) ?? undefined,
      meta: (r.meta as ReponseMeta | null) ?? undefined,
      createdAt: new Date(r.created_at),
    }));
  }

  async incidentsEntre(depuis: Date, jusqua: Date): Promise<{ erreur: number; limite: number }> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT kind, count(*)::int AS n FROM aec_incidents WHERE created_at >= $1 AND created_at < $2 GROUP BY kind`,
      [depuis, jusqua],
    );
    const n = (k: string) => (rows.find((r) => r.kind === k)?.n as number | undefined) ?? 0;
    return { erreur: n("erreur"), limite: n("limite") };
  }

  async avisEntre(depuis: Date, jusqua: Date): Promise<number> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM aec_avis WHERE created_at >= $1 AND created_at < $2`,
      [depuis, jusqua],
    );
    return rows[0].n as number;
  }

  /** Les suites proposées sous la réponse de cette trace, si elle a été donnée à cette personne. */
  async suitesOf(pseudo: string, traceId: string): Promise<string[]> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT suites FROM aec_conversations WHERE pseudo = $1 AND trace_id = $2 AND suites IS NOT NULL LIMIT 1`,
      [pseudo, traceId],
    );
    return (rows[0]?.suites as string[] | undefined) ?? [];
  }

  /** Les suites proposées sous la dernière réponse (moins de 24 h) : « 2 » envoyé au clavier. */
  async lastSuites(pseudo: string): Promise<string[]> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT suites FROM aec_conversations
        WHERE pseudo = $1 AND role = 'assistant' AND created_at > now() - interval '1 day'
        ORDER BY id DESC LIMIT 1`,
      [pseudo],
    );
    return (rows[0]?.suites as string[] | null | undefined) ?? [];
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

  /**
   * Question et réponse de ces traces, pour relire les votes (scripts/feedback.ts). La question est
   * la ligne insérée juste avant la réponse, par le même `append`. Effacées par /oublier et la purge.
   */
  async exchanges(traceIds: string[]): Promise<Map<string, { question: string; answer: string }>> {
    await this.init();
    if (traceIds.length === 0) return new Map();
    const { rows } = await this.pool.query(
      `SELECT a.trace_id, q.content AS question, a.content AS answer
         FROM aec_conversations a
         JOIN aec_conversations q ON q.id = a.id - 1 AND q.pseudo = a.pseudo AND q.role = 'user'
        WHERE a.role = 'assistant' AND a.trace_id = ANY($1)`,
      [traceIds],
    );
    return new Map(rows.map((r) => [r.trace_id as string, { question: r.question as string, answer: r.answer as string }]));
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

  /** Avis des dernières 24 heures de cette personne (pour limiter les envois à l'équipe). */
  async avisRecents(pseudo: string): Promise<number> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM aec_avis WHERE pseudo = $1 AND created_at > now() - interval '1 day'`,
      [pseudo],
    );
    return rows[0].n as number;
  }

  async addAvis(pseudo: string, texte: string, chatSealed?: string): Promise<number> {
    await this.init();
    const { rows } = await this.pool.query(
      `INSERT INTO aec_avis (pseudo, texte, chat_sealed) VALUES ($1, $2, $3) RETURNING id`,
      [pseudo, texte, chatSealed ?? null],
    );
    return Number(rows[0].id);
  }

  async addAvisNotif(memberId: number, messageId: number, avisId: number): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO aec_avis_notifs (member_id, message_id, avis_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [memberId, messageId, avisId],
    );
  }

  /** L'avis dont ce membre de l'équipe a reçu la notification `messageId`. */
  async avisOfNotif(memberId: number, messageId: number): Promise<{ id: number; chatSealed: string | null } | undefined> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT a.id, a.chat_sealed FROM aec_avis_notifs n JOIN aec_avis a ON a.id = n.avis_id
        WHERE n.member_id = $1 AND n.message_id = $2`,
      [memberId, messageId],
    );
    return rows[0] ? { id: Number(rows[0].id), chatSealed: rows[0].chat_sealed } : undefined;
  }

  async avisById(id: number): Promise<{ id: number; chatSealed: string | null } | undefined> {
    await this.init();
    const { rows } = await this.pool.query(`SELECT id, chat_sealed FROM aec_avis WHERE id = $1`, [id]);
    return rows[0] ? { id: Number(rows[0].id), chatSealed: rows[0].chat_sealed } : undefined;
  }

  async listAvis({ jours = 30, limit = 50 } = {}): Promise<{ id: number; pseudo: string; texte: string; createdAt: Date }[]> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT id, pseudo, texte, created_at FROM aec_avis
        WHERE created_at > now() - make_interval(days => $1) ORDER BY created_at DESC LIMIT $2`,
      [jours, limit],
    );
    return rows.map((r) => ({ id: Number(r.id), pseudo: r.pseudo, texte: r.texte, createdAt: r.created_at }));
  }

  async addAvisPrompt(pseudo: string, promptMessageId: number): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO aec_avis_prompts (pseudo, prompt_message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [pseudo, promptMessageId],
    );
  }

  /** Consomme l'invitation /avis à laquelle ce message répond, s'il y en a une. */
  async takeAvisPrompt(pseudo: string, promptMessageId: number): Promise<boolean> {
    await this.init();
    const r = await this.pool.query(
      `DELETE FROM aec_avis_prompts WHERE pseudo = $1 AND prompt_message_id = $2
         AND created_at > now() - interval '1 day'`,
      [pseudo, promptMessageId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Droit à l'effacement : /oublier. */
  async forget(pseudo: string): Promise<number> {
    await this.init();
    const a = await this.pool.query(`DELETE FROM aec_conversations WHERE pseudo = $1`, [pseudo]);
    await this.pool.query(`DELETE FROM aec_rate_limit WHERE pseudo = $1`, [pseudo]);
    await this.pool.query(`DELETE FROM aec_feedback_prompts WHERE pseudo = $1`, [pseudo]);
    await this.pool.query(`DELETE FROM aec_avis WHERE pseudo = $1`, [pseudo]);
    await this.pool.query(`DELETE FROM aec_avis_prompts WHERE pseudo = $1`, [pseudo]);
    return a.rowCount ?? 0;
  }

  /** Purge nocturne : conversations plus vieilles que `days`, compteurs expirés. */
  async purge(days: number): Promise<{ messages: number; compteurs: number; avis: number }> {
    await this.init();
    const m = await this.pool.query(
      `DELETE FROM aec_conversations WHERE created_at < now() - make_interval(days => $1)`,
      [days],
    );
    const c = await this.pool.query(`DELETE FROM aec_rate_limit WHERE window_start < now() - interval '2 hours'`);
    await this.pool.query(`DELETE FROM aec_feedback_prompts WHERE created_at < now() - interval '1 day'`);
    const a = await this.pool.query(`DELETE FROM aec_avis WHERE created_at < now() - make_interval(days => $1)`, [days]);
    await this.pool.query(`DELETE FROM aec_avis_prompts WHERE created_at < now() - interval '1 day'`);
    await this.pool.query(`DELETE FROM aec_incidents WHERE created_at < now() - make_interval(days => $1)`, [days]);
    return { messages: m.rowCount ?? 0, compteurs: c.rowCount ?? 0, avis: a.rowCount ?? 0 };
  }
}
