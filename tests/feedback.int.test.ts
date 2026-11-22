/**
 * Feedback de bout en bout avec la vraie configuration Mastra (PostgresStoreVNext +
 * observabilité) : la réponse est tracée, le vote s'attache à sa trace, /oublier efface tout.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeModel } from "./helpers/fake-model.js";

const DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB)("feedback Mastra (Postgres réel)", () => {
  let mastra: typeof import("../src/mastra/index.js").mastra;
  let repondre: typeof import("../src/aec/repondre.js").repondre;
  let sink: import("../src/telegram/feedback.js").FeedbackSink;
  let obs: any;
  const copied: import("@mastra/core/observability").FeedbackEvent[] = [];

  const flush = async () => {
    await (mastra.observability as unknown as { flush?: () => Promise<void> }).flush?.();
    await new Promise((r) => setTimeout(r, 1500));
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    // Comme en production sur Mastra Platform : sans ça, le retrait silencieux de
    // MastraStorageExporter par la plateforme passait inaperçu (voir storage-exporter.ts).
    process.env.MASTRA_DEPLOYMENT_ID ??= "dep_test";
    process.env.MISTRAL_API_KEY ??= "test";
    const deps = await import("../src/corpus/deps.js");
    deps.setRetrievalDeps({
      embedder: { dimension: 3, embed: async (t: string[]) => t.map(() => [1, 0, 0]) },
      vector: {
        query: (async () => [
          {
            id: "wp:media:15699#p37#0", score: 0.9,
            metadata: {
              docId: "wp:media:15699", title: "PROGRAMME SITE 2025", url: "https://x/p.pdf", page: 37,
              category: "programme", corpus: "aec2027", provisional: true, text: "Augmenter le SMIC à 1 600 € net.",
            },
          },
        ]) as never,
      },
    });
    ({ mastra } = await import("../src/mastra/index.js"));
    ({ repondre } = await import("../src/aec/repondre.js"));
    const { mastraFeedbackSink } = await import("../src/telegram/feedback.js");
    sink = mastraFeedbackSink(mastra, { onFeedbackEvent: async (e) => void copied.push(e) });
    obs = await mastra.getStorage()!.getStore("observability");
  });

  afterAll(async () => {
    await (mastra?.getStorage() as unknown as { close?: () => Promise<void> })?.close?.();
  });

  it("trace la réponse, y attache le vote et le commentaire, et /oublier efface tout", async () => {
    const model = fakeModel((_p, call) =>
      call === 1 ? { tool: "recherche", input: { requete: "SMIC" } } : { text: "Le SMIC passe à 1 600 € net [P1]." },
    );
    const res = await repondre("De combien augmenter le SMIC ?", { model });
    expect(res.reponse.statut).toBe("repondu");
    expect(res.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(res.spanId).toBeTruthy();

    // Vote immédiat, comme un clic juste après la réponse : les spans ne sont peut-être pas encore
    // écrits en base, le vote doit être enregistré quand même.
    const target = { traceId: res.traceId!, spanId: res.spanId!, pseudo: "u_test" };
    await sink.vote({ ...target, value: -1 });
    await sink.comment({ ...target, comment: "Il manque la version 2022" });
    const { feedback } = await obs.listFeedback({ filters: { traceId: res.traceId } });
    expect(feedback.map((f: any) => [f.feedbackType, f.value, f.feedbackUserId, f.spanId]).sort()).toEqual([
      ["comment", "Il manque la version 2022", "u_test", res.spanId],
      ["thumbs", -1, "u_test", res.spanId],
    ]);
    // La même chose part vers Mastra Cloud, rattachée à la trace et à l'agent.
    expect(copied.map((e) => [e.feedback.feedbackType, e.feedback.value, e.feedback.traceId, e.feedback.correlationContext?.entityId])).toEqual([
      ["thumbs", -1, res.traceId, "aec"],
      ["comment", "Il manque la version 2022", res.traceId, "aec"],
    ]);

    await flush();
    const trace = await obs.getTrace({ traceId: res.traceId });
    expect(trace?.spans?.length).toBeGreaterThan(0);
    // Le span racine porte le traceId que le bot range dans aec_conversations.trace_id.
    const racine = trace.spans.find((s: any) => !s.parentSpanId);
    expect(racine).toMatchObject({ traceId: res.traceId, spanId: res.spanId });

    await sink.forgetTraces([res.traceId!]);
    expect(await obs.getTrace({ traceId: res.traceId })).toBeNull();
    expect((await obs.listFeedback({ filters: { traceId: res.traceId } })).feedback).toEqual([]);
  });

  it("ne trace pas ce qui ne passe pas par repondre() (ingestion, appels directs)", async () => {
    const r = await mastra.getAgent("aec").generate("Bonjour", { model: fakeModel(() => ({ text: "Salut" })) as never });
    await flush();
    expect(r.traceId ? await obs.getTrace({ traceId: r.traceId }) : null).toBeNull();
  });
});
