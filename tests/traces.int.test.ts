/**
 * Traces en base une fois déployé sur Mastra Cloud. La plateforme définit MASTRA_DEPLOYMENT_ID,
 * et @mastra/observability retire alors tout MastraStorageExporter : en production, aucun span
 * n'arrivait dans mastra_span_events. On reproduit ici cet environnement.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeModel } from "./helpers/fake-model.js";

const DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB)("traces en base sur Mastra Cloud (Postgres réel)", () => {
  let mastra: typeof import("../src/mastra/index.js").mastra;
  let repondre: typeof import("../src/aec/repondre.js").repondre;
  let verifierTraces: typeof import("../src/mastra/traces-check.js").verifierTraces;
  let pool: pg.Pool;
  const before = process.env.MASTRA_DEPLOYMENT_ID;

  beforeAll(async () => {
    process.env.MASTRA_DEPLOYMENT_ID = "dep_test";
    process.env.DATABASE_URL = DB;
    process.env.OPENROUTER_API_KEY ??= "test";
    const deps = await import("../src/corpus/deps.js");
    deps.setRetrievalDeps({
      embedder: { dimension: 3, embed: async (t: string[]) => t.map(() => [1, 0, 0]) },
      vector: {
        query: (async () => [
          {
            id: "wp:media:1#p1#0", score: 0.9,
            metadata: {
              docId: "wp:media:1", title: "Programme", url: "https://x/p.pdf", page: 1,
              category: "programme", corpus: "aec2027", provisional: true, text: "Retraite à 60 ans.",
            },
          },
        ]) as never,
      },
    });
    ({ mastra } = await import("../src/mastra/index.js"));
    ({ repondre } = await import("../src/aec/repondre.js"));
    ({ verifierTraces } = await import("../src/mastra/traces-check.js"));
    pool = new pg.Pool({ connectionString: DB });
  });

  afterAll(async () => {
    if (before === undefined) delete process.env.MASTRA_DEPLOYMENT_ID;
    else process.env.MASTRA_DEPLOYMENT_ID = before;
    await pool?.end();
    await (mastra?.getStorage() as unknown as { close?: () => Promise<void> })?.close?.();
  });

  it("garde l'exporteur vers la base malgré le filtre de la plateforme", () => {
    const names = (mastra.observability as any).getDefaultInstance().getExporters().map((e: { name: string }) => e.name);
    expect(names).toContain("aec-neon-storage");
  });

  it("une réponse du bot a son span racine dans mastra_span_events, même traceId qu'aec_conversations", async () => {
    const { botStore } = await import("../src/telegram/runtime.js");
    const model = fakeModel((_p, call) =>
      call === 1 ? { tool: "recherche", input: { requete: "retraite" } } : { text: "La retraite à 60 ans [P1]." },
    );
    await pool.query(`DELETE FROM aec_conversations WHERE pseudo = 'u_traces'`).catch(() => {});
    const res = await repondre("Retraite ?", { model });
    expect(res.traceId).toMatch(/^[0-9a-f]{32}$/);
    await botStore().append("u_traces", "Retraite ?", res.reponse.texte, res.traceId, res.spanId);

    await (mastra.observability as unknown as { flush(): Promise<void> }).flush();
    // La purge nocturne (rétention MEMORY_DAYS) ne doit pas effacer une trace du jour.
    await (mastra.getStorage() as unknown as { prune(): Promise<unknown> }).prune();
    const { rows } = await pool.query(
      `SELECT DISTINCT s."spanId" FROM mastra_span_events s
         JOIN aec_conversations c ON c.trace_id = s."traceId"
        WHERE c.pseudo = 'u_traces' AND c.trace_id = $1 AND s."parentSpanId" IS NULL`,
      [res.traceId],
    );
    expect(rows.map((r) => r.spanId)).toEqual([res.spanId]);

    // Le contrôle de /status ne voit aucune réponse sans trace…
    await pool.query(`UPDATE aec_conversations SET created_at = now() - interval '5 minutes' WHERE pseudo = 'u_traces'`);
    expect(await verifierTraces(pool)).toMatchObject({ sansTrace: 0 });
    // …et repère celle dont la trace manque.
    await pool.query(
      `INSERT INTO aec_conversations (pseudo, role, content, trace_id, created_at)
       VALUES ('u_traces', 'assistant', 'x', 'trace-perdue', now() - interval '5 minutes')`,
    );
    expect(await verifierTraces(pool)).toMatchObject({ sansTrace: 1 });
    await pool.query(`DELETE FROM aec_conversations WHERE pseudo = 'u_traces'`);
  });
});
