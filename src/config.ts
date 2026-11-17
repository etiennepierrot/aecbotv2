import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL manquant"),
  MISTRAL_API_KEY: z.string().optional(),
  /** Alternative à MISTRAL_API_KEY : mêmes modèles Mistral, servis via OpenRouter. */
  OPENROUTER_API_KEY: z.string().optional(),
  WP_BASE_URL: z.string().url().default("https://melenchon2027.fr"),
  INGEST_CRON: z.string().optional(),
  /**
   * Éditions interrogées par défaut, dans l'ordre de préférence. Tant que le programme 2027
   * n'est pas publié : « aec2027,aec2022 ». Ensuite : « aec2027 » seul.
   */
  EDITIONS: z
    .string()
    .default("aec2027,aec2022")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(["aec2027", "aec2022"])).min(1)),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  /** Vérifié sur chaque appel du webhook (en-tête X-Telegram-Bot-Api-Secret-Token). */
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  /** Clé HMAC pour pseudonymiser les identifiants Telegram. Ne jamais la changer en production. */
  PSEUDONYM_SECRET: z.string().optional(),
  RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(20),
  /** Durée de conservation de la mémoire de conversation. */
  MEMORY_DAYS: z.coerce.number().int().positive().default(30),
  /** Identifiants Telegram de l'équipe (séparés par des virgules) : /ajouter, /docs, /supprimer. */
  TEAM_TELEGRAM_IDS: z
    .string()
    .default("")
    .transform((s) => new Set(s.split(",").map((x) => x.trim()).filter(Boolean).map(Number).filter(Number.isFinite))),
  /**
   * Similarité minimale (cosinus) entre une suite proposée et son meilleur passage pour l'afficher.
   * À calibrer avec `pnpm suites:calibrer` sur le corpus réel.
   */
  SUITES_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.8),
  /** Protège les routes /api/* (Studio, agents, workflows) une fois déployé. */
  ADMIN_API_TOKEN: z.string().optional(),

  // --- Argumentaire : captures et consolidation -------------------------------------------
  /** Modèle d'extraction et d'évaluation des affirmations (vide : le modèle de réponse par défaut). */
  CONSOLIDATION_MODEL: z.string().optional(),
  /** Modèle de vision qui transcrit les captures d'écran. */
  CONSOLIDATION_VISION_MODEL: z.string().optional(),
  /** Captures consolidées au plus par jour, toutes sources confondues : garde-fou des collectes automatiques. */
  CONSOLIDATION_MAX_PER_DAY: z.coerce.number().int().positive().default(50),
  /** Captures acceptées par jeton d'extension sur 24 heures glissantes. */
  CAPTURE_MAX_PER_TOKEN: z.coerce.number().int().positive().default(100),
  /** Adresse publique du serveur, pour les liens envoyés sur Telegram (interface /admin). */
  ADMIN_BASE_URL: z.string().url().optional(),
});

export type AppConfig = z.infer<typeof Env>;

let cached: AppConfig | undefined;

/** Les modèles Mistral par défaut, en direct ou via OpenRouter selon la clé disponible. */
export function defaultModels(env: NodeJS.ProcessEnv = process.env) {
  const viaOpenRouter = !env.MISTRAL_API_KEY && !!env.OPENROUTER_API_KEY;
  return viaOpenRouter
    ? { answer: "openrouter/mistralai/mistral-small-2603", judge: "openrouter/mistralai/mistral-medium-3-5" }
    : { answer: "mistral/mistral-small-latest", judge: "mistral/mistral-medium-latest" };
}

/** Échoue tout de suite, avec un message clair, si la clé du fournisseur d'un modèle manque. */
export function assertModelKey(model: string, env: NodeJS.ProcessEnv = process.env): void {
  const needs: Record<string, string> = { mistral: "MISTRAL_API_KEY", openrouter: "OPENROUTER_API_KEY", openai: "OPENAI_API_KEY" };
  const provider = model.split("/")[0] ?? "";
  const key = needs[provider];
  if (key && !env[key]?.trim()) {
    const origine =
      env.AEC_MODEL?.trim() === model || env.AEC_JUDGE_MODEL?.trim() === model
        ? "imposé par AEC_MODEL ou AEC_JUDGE_MODEL"
        : "choisi par défaut car ni MISTRAL_API_KEY ni OPENROUTER_API_KEY ne sont renseignées";
    const presentes = ["MISTRAL_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"].filter((k) => env[k]?.trim());
    throw new Error(
      `Le modèle « ${model} » (${origine}) demande ${key}, absente de l'environnement. ` +
        `Clés présentes : ${presentes.join(", ") || "aucune"}. ` +
        `Renseignez ${key}, ou mettez dans AEC_MODEL / AEC_JUDGE_MODEL un modèle du fournisseur dont vous avez la clé.`,
    );
  }
}

export function config(): AppConfig {
  cached ??= Env.parse(process.env);
  return cached;
}

/** Nom de l'index pgvector qui contient les passages. */
export const PASSAGES_INDEX = "aec_passages";
/** mistral-embed produit des vecteurs de 1024 dimensions. */
export const EMBEDDING_DIMENSION = 1024;
