import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { config } from "../../config.js";
import { botStore } from "../../telegram/runtime.js";

const out = z.object({ messages: z.number(), compteurs: z.number(), avis: z.number(), traces: z.number() });

const purger = createStep({
  id: "purger",
  description:
    "Efface les conversations plus anciennes que MEMORY_DAYS, les compteurs expirés, et (rétention " +
    "du stockage Mastra) les traces, votes et exécutions de workflows du même âge. Les captures de " +
    "l'argumentaire n'en font pas partie : elles sont gardées sans limite (suppression explicite seulement). " +
    "La copie anonymisée des questions (aec_questions_anonymes) non plus : sans lien avec la personne, elle est gardée sans limite.",
  inputSchema: z.object({}),
  outputSchema: out,
  execute: async ({ mastra }) => {
    const bot = await botStore().purge(config().MEMORY_DAYS);
    const storage = mastra?.getStorage() as { prune?: () => Promise<unknown> } | undefined;
    const pruned = storage?.prune ? await storage.prune() : undefined;
    return { ...bot, traces: countDeleted(pruned) };
  },
});

/** prune() renvoie un résultat par table ; on additionne les lignes supprimées. */
function countDeleted(result: unknown): number {
  let n = 0;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "deleted" && typeof x === "number") n += x;
        else walk(x);
      }
    }
  };
  walk(result);
  return n;
}

const cron = process.env.PURGE_CRON?.trim();

export const purgeWorkflow = createWorkflow({
  id: "purge",
  description: "Purge nocturne des données personnelles du bot (RGPD).",
  inputSchema: z.object({}),
  outputSchema: out,
  ...(cron ? { schedule: { id: "purge-nocturne", cron, timezone: "Europe/Paris", inputData: {} } } : {}),
})
  .then(purger)
  .commit();
