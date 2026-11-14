import { Mastra } from "@mastra/core";
import { PinoLogger } from "@mastra/loggers";
import { MastraStorageExporter, Observability, SamplingStrategyType } from "@mastra/observability";
import { PostgresStoreVNext } from "@mastra/pg";
import { COLLECTOR_KEY } from "../aec/collector.js";
import { cloudExporter } from "./cloud-exporter.js";
import { registerApiRoute, SimpleAuth } from "@mastra/core/server";
import { config, PASSAGES_INDEX } from "../config.js";
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
    const version = process.env.AEC_VERSION ?? "dev";
    try {
      const { rows } = await pgVector().pool.query(
        `SELECT to_regclass('${PASSAGES_INDEX}') IS NOT NULL AS index_present`,
      );
      if (!rows[0].index_present) {
        // Base joignable mais sans index : mauvaise base, ou aucun scan encore fait sur celle-ci.
        return c.json({ status: "index absent", version }, 503);
      }
      const n = await pgVector().pool.query(`SELECT count(*)::int AS n FROM ${PASSAGES_INDEX}`);
      return c.json({ status: "ok", version, passages: n.rows[0].n });
    } catch {
      return c.json({ status: "base injoignable", version }, 503);
    }
  },
});

const apiRoutes = cfg.TELEGRAM_BOT_TOKEN
  ? [
      statusRoute,
      registerApiRoute("/telegram", {
        method: "POST",
        createHandler: async ({ mastra }) => {
          const bot = botFromEnv(
            { info: (msg, meta) => logger.info(msg, meta), error: (msg, meta) => logger.error(msg, meta) },
            mastra,
          );
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
  // « VNext » : la variante dont l'observabilité gère le feedback (votes 👍/👎).
  storage: new PostgresStoreVNext({
    id: "aec-storage",
    connectionString: cfg.DATABASE_URL,
    observability: { connectionString: cfg.DATABASE_URL },
    // Traces et votes contiennent les questions : même durée que la mémoire du bot.
    // Appliqué chaque nuit par le workflow purge (storage.prune()).
    retention: {
      observability: {
        spans: { maxAge: `${cfg.MEMORY_DAYS}d` },
        feedback: { maxAge: `${cfg.MEMORY_DAYS}d` },
        logs: { maxAge: `${cfg.MEMORY_DAYS}d` },
        scores: { maxAge: `${cfg.MEMORY_DAYS}d` },
        metrics: { maxAge: `${cfg.MEMORY_DAYS}d` },
      },
      workflows: { workflowSnapshot: { maxAge: `${cfg.MEMORY_DAYS}d` } },
    },
  }),
  // Traces des seules réponses aux questions (pas de l'ingestion), pour y attacher le feedback.
  observability: new Observability({
    configs: {
      default: {
        serviceName: "aecbot",
        // Neon (Studio, /oublier, purge) et, si un token est fourni, Mastra Cloud.
        exporters: [new MastraStorageExporter(), cloudExporter],
        sampling: { type: SamplingStrategyType.CUSTOM, sampler: (o) => o?.requestContext?.get(COLLECTOR_KEY as never) !== undefined },
        logging: { enabled: false },
      },
    },
  }),
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
