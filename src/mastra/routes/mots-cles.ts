import { registerApiRoute } from "@mastra/core/server";
import type { Context } from "hono";
import { config } from "../../config.js";
import { motsCles, nuageHtml } from "../../telegram/mots-cles.js";
import { botStore } from "../../telegram/runtime.js";
import type { BotStore } from "../../telegram/store.js";

/**
 * GET /stats/mots-cles : nuage des mots-clés les plus demandés au bot.
 * Protégée par ADMIN_API_TOKEN (requiresAuth par défaut). Ne renvoie que des comptes agrégés.
 *
 * Paramètres : `jours` (défaut et maximum MEMORY_DAYS, au-delà les questions sont purgées),
 * `limite` (défaut 100, max 500), `min_personnes` (défaut 2, min 2), `format` = json | html.
 */

function entier(v: string | undefined, defaut: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : defaut;
}

export function motsClesHandler(deps: () => { store: Pick<BotStore, "questionsRecentes">; memoryDays: number }) {
  return async (c: Context): Promise<Response> => {
    const { store, memoryDays } = deps();
    const jours = entier(c.req.query("jours"), memoryDays, 1, memoryDays);
    const limite = entier(c.req.query("limite"), 100, 1, 500);
    // Jamais moins de 2 : un mot employé par une seule personne pourrait l'identifier.
    const minPersonnes = entier(c.req.query("min_personnes"), 2, 2, 1000);
    const questions = await store.questionsRecentes(jours);
    const resultat = motsCles(questions, { limite, minPersonnes });
    if (c.req.query("format") === "html") return c.html(nuageHtml(resultat, { jours }));
    return c.json({ jours, questions: questions.length, minPersonnes, mots: resultat });
  };
}

export function motsClesRoutes() {
  const deps = () => ({ store: botStore(), memoryDays: config().MEMORY_DAYS });
  return [registerApiRoute("/stats/mots-cles", { method: "GET", handler: motsClesHandler(deps) })];
}
