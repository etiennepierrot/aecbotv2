import { Api } from "grammy";
import { searchPassages } from "../aec/search.js";
import { config } from "../config.js";
import { pgVector, retrievalDeps } from "../corpus/deps.js";
import { CATEGORIES_PROGRAMME } from "../corpus/types.js";
import { creerAnalyseur } from "./analyse.js";
import type { ConsolidationDeps } from "./consolidation.js";
import { ArguStore } from "./store.js";

let store: ArguStore | undefined;

/** Stockage de l'argumentaire, sur la même base que le corpus et le bot. */
export function arguStore(): ArguStore {
  store ??= new ArguStore(pgVector().pool);
  return store;
}

type Logger = ConsolidationDeps["logger"];

let deps: ConsolidationDeps | undefined;

/** Dépendances de la consolidation, construites depuis l'environnement (remplaçables en test). */
export async function consolidationDeps(logger?: Logger): Promise<ConsolidationDeps> {
  if (!deps) {
    const cfg = config();
    const { embedder } = await retrievalDeps();
    deps = {
      store: arguStore(),
      analyseur: creerAnalyseur(),
      // Le programme seulement, sans élargir à la page : de quoi juger si le programme répond.
      rechercher: (requete) => searchPassages({ requete, categories: CATEGORIES_PROGRAMME, elargir: false, topK: 5 }),
      embedder,
      notifier: notifierEquipe,
      maxParJour: cfg.CONSOLIDATION_MAX_PER_DAY,
      seuilRegroupement: cfg.REGROUPEMENT_MIN_SCORE,
      seuilVerification: cfg.VERIFICATION_MIN_SCORE,
      adminUrl: cfg.ADMIN_BASE_URL,
      logger,
    };
  }
  return deps;
}

export function setConsolidationDeps(d: ConsolidationDeps | undefined): void {
  deps = d;
}

/** Message privé à chaque membre de l'équipe (sans bot configuré : rien). */
async function notifierEquipe(message: string): Promise<void> {
  const cfg = config();
  if (!cfg.TELEGRAM_BOT_TOKEN) return;
  const api = new Api(cfg.TELEGRAM_BOT_TOKEN);
  for (const membre of cfg.TEAM_TELEGRAM_IDS) {
    // Un membre qui n'a jamais écrit au bot ne peut pas recevoir de message : on continue.
    await api.sendMessage(membre, message, { link_preview_options: { is_disabled: true } }).catch(() => undefined);
  }
}
