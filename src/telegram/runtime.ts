import { webhookCallback, type Bot } from "grammy";
import { repondre } from "../aec/repondre.js";
import { assertModelKey, config } from "../config.js";
import { DEFAULT_MODEL } from "../mastra/agents/aec.js";
import { pgVector } from "../corpus/deps.js";
import type { Mastra } from "@mastra/core";
import { createBot } from "./bot.js";
import { mastraFeedbackSink } from "./feedback.js";
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
  return createBot(cfg.TELEGRAM_BOT_TOKEN, {
    repondre,
    store: botStore(),
    pseudonymSecret: cfg.PSEUDONYM_SECRET,
    ratePerHour: cfg.RATE_LIMIT_PER_HOUR,
    memoryDays: cfg.MEMORY_DAYS,
    feedback: mastra ? mastraFeedbackSink(mastra) : undefined,
    logger,
  });
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
