import type { Pool } from "pg";

export interface TracesCheck {
  /** Réponses du bot rattachées à une trace, sur la fenêtre observée. */
  reponses: number;
  /** Parmi elles, celles dont le span racine n'est pas dans `mastra_span_events`. */
  sansTrace: number;
}

/**
 * Vérifie que les réponses du bot ont bien leur trace en base : chaque `aec_conversations.trace_id`
 * doit avoir un span racine dans `mastra_span_events`. Les spans partent par lots (quelques
 * secondes) : les réponses de moins de `margeMinutes` ne sont pas comptées.
 */
export async function verifierTraces(pool: Pool, opts: { heures?: number; margeMinutes?: number } = {}): Promise<TracesCheck> {
  const { heures = 24, margeMinutes = 2 } = opts;
  const { rows } = await pool.query(
    `SELECT to_regclass('aec_conversations') IS NOT NULL AS conv, to_regclass('mastra_span_events') IS NOT NULL AS spans`,
  );
  if (!rows[0].conv) return { reponses: 0, sansTrace: 0 };
  const recentes = `FROM aec_conversations c
     WHERE c.role = 'assistant' AND c.trace_id IS NOT NULL
       AND c.created_at > now() - make_interval(hours => $1)
       AND c.created_at < now() - make_interval(mins => $2)`;
  const sansTrace = rows[0].spans
    ? `count(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM mastra_span_events s WHERE s."traceId" = c.trace_id AND s."parentSpanId" IS NULL))`
    : "count(*)";
  const r = await pool.query(`SELECT count(*)::int AS reponses, ${sansTrace}::int AS sans_trace ${recentes}`, [heures, margeMinutes]);
  return { reponses: r.rows[0].reponses, sansTrace: r.rows[0].sans_trace };
}
