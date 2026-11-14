import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { config } from "../../config.js";
import { botStore } from "../../telegram/runtime.js";

const out = z.object({ messages: z.number(), compteurs: z.number() });

const purger = createStep({
  id: "purger",
  description: "Efface les conversations plus anciennes que MEMORY_DAYS et les compteurs expirés.",
  inputSchema: z.object({}),
  outputSchema: out,
  execute: async () => botStore().purge(config().MEMORY_DAYS),
});

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
