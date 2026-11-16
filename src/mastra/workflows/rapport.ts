import { createStep, createWorkflow } from "@mastra/core/workflows";
import { Api } from "grammy";
import { z } from "zod";
import { config } from "../../config.js";
import { botStore } from "../../telegram/runtime.js";
import { collecterRapport, decouperMessages, formatRapport, votesDepuisObservabilite } from "../../telegram/rapport.js";

const out = z.object({ questions: z.number(), messages: z.number(), destinataires: z.number(), envoyes: z.number() });

/**
 * Le rapport des dernières `heures` heures, envoyé en message privé à chaque membre de
 * TEAM_TELEGRAM_IDS. Un membre qui n'a jamais écrit au bot ne peut pas le recevoir.
 */
const envoyer = createStep({
  id: "envoyer",
  description: "Construit le rapport des dernières 24 h et l'envoie à l'équipe sur Telegram.",
  inputSchema: z.object({ heures: z.number().int().positive().default(24) }),
  outputSchema: out,
  execute: async ({ inputData, mastra }) => {
    const cfg = config();
    if (!cfg.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN manquant : rapport non envoyé");
    const jusqua = new Date();
    const depuis = new Date(jusqua.getTime() - inputData.heures * 3_600_000);
    const obs = (await mastra?.getStorage()?.getStore("observability")) as never;
    const donnees = await collecterRapport({ store: botStore(), votesDepuis: votesDepuisObservabilite(obs) }, depuis, jusqua);
    const messages = decouperMessages(formatRapport(donnees));

    const api = new Api(cfg.TELEGRAM_BOT_TOKEN);
    let envoyes = 0;
    for (const membre of cfg.TEAM_TELEGRAM_IDS) {
      try {
        for (const m of messages) await api.sendMessage(membre, m, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
        envoyes++;
      } catch {
        // Membre injoignable (n'a jamais écrit au bot, l'a bloqué) : on continue avec les autres.
      }
    }
    return { questions: donnees.echanges.length, messages: messages.length, destinataires: cfg.TEAM_TELEGRAM_IDS.size, envoyes };
  },
});

const cron = process.env.RAPPORT_CRON?.trim();

export const rapportWorkflow = createWorkflow({
  id: "rapport",
  description: "Rapport journalier des discussions du bot, envoyé à l'équipe sur Telegram.",
  inputSchema: z.object({ heures: z.number().int().positive().default(24) }),
  outputSchema: out,
  ...(cron ? { schedule: { id: "rapport-journalier", cron, timezone: "Europe/Paris", inputData: { heures: 24 } } } : {}),
})
  .then(envoyer)
  .commit();
