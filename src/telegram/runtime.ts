import { webhookCallback, type Bot } from "grammy";
import { repondre } from "../aec/repondre.js";
import { assertModelKey, config } from "../config.js";
import { DEFAULT_MODEL } from "../mastra/agents/aec.js";
import { pgVector } from "../corpus/deps.js";
import type { Mastra } from "@mastra/core";
import { createBot } from "./bot.js";
import { mastraFeedbackSink } from "./feedback.js";
import { cloudExporter } from "../mastra/cloud-exporter.js";
import { ajouterDocument, listerDocuments, MAX_PDF_BYTES, supprimerDocument } from "../corpus/manual.js";
import { BotStore } from "./store.js";

let store: BotStore | undefined;
export function botStore(): BotStore {
  store ??= new BotStore(pgVector().pool);
  return store;
}

/** Le bot construit depuis l'environnement (webhook en production, polling en local). */
export function botFromEnv(logger?: Parameters<typeof createBot>[1]["logger"], mastra?: Mastra): Bot {
  const cfg = config();
  if (!cfg.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN manquant");
  assertModelKey(DEFAULT_MODEL);
  if (!cfg.PSEUDONYM_SECRET || cfg.PSEUDONYM_SECRET.length < 32) {
    throw new Error("PSEUDONYM_SECRET manquant ou trop court (32 caractères au moins)");
  }
  const token = cfg.TELEGRAM_BOT_TOKEN;
  const bot = createBot(token, {
    repondre,
    store: botStore(),
    pseudonymSecret: cfg.PSEUDONYM_SECRET,
    ratePerHour: cfg.RATE_LIMIT_PER_HOUR,
    memoryDays: cfg.MEMORY_DAYS,
    feedback: mastra ? mastraFeedbackSink(mastra, cloudExporter) : undefined,
    team: cfg.TEAM_TELEGRAM_IDS,
    admin: mastra
      ? {
          ajouter: (a) => ajouterDocument(mastra, a),
          lister: listerDocuments,
          supprimer: supprimerDocument,
          telecharger: async (fileId) => {
            const file = await bot.api.getFile(fileId);
            if (!file.file_path) throw new Error("Telegram ne fournit pas ce fichier");
            if ((file.file_size ?? 0) > MAX_PDF_BYTES) throw new Error("PDF trop gros (20 Mo au plus)");
            const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
            if (!res.ok) throw new Error(`Téléchargement Telegram impossible (${res.status})`);
            return new Uint8Array(await res.arrayBuffer());
          },
        }
      : undefined,
    logger,
  });
  return bot;
}

/**
 * Gestionnaire Hono du webhook. Telegram envoie l'en-tête secret défini au setWebhook ;
 * sans lui, grammY répond 401. On attend la fin du traitement (serverless) ; au-delà
 * de 50 s on rend la main pour que Telegram ne renvoie pas la même mise à jour.
 */
export function telegramWebhookHandler(bot: Bot, secretToken: string | undefined) {
  if (!secretToken) throw new Error("TELEGRAM_WEBHOOK_SECRET manquant : le webhook serait ouvert à tous");
  return webhookCallback(bot, "hono", { secretToken, onTimeout: "return", timeoutMilliseconds: 50_000 });
}
