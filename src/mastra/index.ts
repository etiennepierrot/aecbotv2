import { Mastra } from "@mastra/core";
import { PinoLogger } from "@mastra/loggers";
import { PostgresStore } from "@mastra/pg";
import { registerApiRoute, SimpleAuth } from "@mastra/core/server";
import { config } from "../config.js";
import { pgVector } from "../corpus/deps.js";
import { botFromEnv, telegramWebhookHandler } from "../telegram/runtime.js";
import { aecAgent } from "./agents/aec.js";
import { scorers } from "./scorers/index.js";
import { ingestDocumentWorkflow, ingestWorkflow } from "./workflows/ingest.js";
import { purgeWorkflow } from "./workflows/purge.js";

const cfg = config();
const logger = new PinoLogger({ name: "aecbot", level: "info" });

/** Sonde publique pour le test après déploiement : version en ligne et base joignable (/health est pris par Mastra). */
const statusRoute = registerApiRoute("/status", {
  method: "GET",
  handler: async (c) => {
    try {
      await pgVector().pool.query("SELECT 1");
      return c.json({ status: "ok", version: process.env.AEC_VERSION ?? "dev" });
    } catch {
      return c.json({ status: "base injoignable" }, 503);
    }
  },
});

const apiRoutes = cfg.TELEGRAM_BOT_TOKEN
  ? [
      statusRoute,
      registerApiRoute("/telegram", {
        method: "POST",
        createHandler: async () => {
          const bot = botFromEnv({
            info: (msg, meta) => logger.info(msg, meta),
            error: (msg, meta) => logger.error(msg, meta),
          });
          // Pas de bot.init() ici : grammY appelle getMe au premier message, le démarrage ne dépend pas de Telegram.
          return telegramWebhookHandler(bot, cfg.TELEGRAM_WEBHOOK_SECRET);
        },
      }),
    ]
  : [statusRoute];

export const mastra = new Mastra({
  agents: { aec: aecAgent },
  scorers,
  workflows: { ingest: ingestWorkflow, ingestDocument: ingestDocumentWorkflow, purge: purgeWorkflow },
  vectors: { aec: pgVector() },
  storage: new PostgresStore({ id: "aec-storage", connectionString: cfg.DATABASE_URL }),
  logger,
  server: {
    apiRoutes,
    // En production, /api/* (Studio, agents, workflows) exige ce jeton ; /telegram reste public,
    // protégé par le secret du webhook.
    ...(cfg.ADMIN_API_TOKEN
      ? { auth: new SimpleAuth({
            tokens: { [cfg.ADMIN_API_TOKEN]: { id: "equipe", name: "Équipe AECBot" } },
            public: ["/telegram", "/status"],
          }), }
      : {}),
  },
});
