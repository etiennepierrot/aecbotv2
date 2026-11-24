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
 * Jusqu'à MEMORY_DAYS jours, lit la mémoire du bot (filtre : au moins `min_personnes` personnes).
 * Au-delà, lit la copie anonymisée, gardée sans limite (filtre : au moins `min_questions` questions).
 *
 * Paramètres : `jours` (défaut MEMORY_DAYS, max 3650), `limite` (défaut 100, max 500),
 * `min_personnes` (défaut et min 2), `min_questions` (défaut et min 3), `format` = json | html.
 */

export const JOURS_MAX = 3650;

function entier(v: string | undefined, defaut: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : defaut;
}

type Deps = { store: Pick<BotStore, "questionsRecentes" | "questionsAnonymes">; memoryDays: number };

export function motsClesHandler(deps: () => Deps) {
  return async (c: Context): Promise<Response> => {
    const { store, memoryDays } = deps();
    const jours = entier(c.req.query("jours"), memoryDays, 1, JOURS_MAX);
    const limite = entier(c.req.query("limite"), 100, 1, 500);
    const anonyme = jours > memoryDays;
    // Jamais moins de 2 personnes : un mot employé par une seule pourrait l'identifier. Sans
    // pseudonyme, on exige 3 questions, la même personne pouvant poser deux fois la même.
    const minPersonnes = entier(c.req.query("min_personnes"), 2, 2, 1000);
    const minQuestions = entier(c.req.query("min_questions"), 3, 3, 100_000);
    const questions = anonyme
      ? (await store.questionsAnonymes(jours)).map((content) => ({ content }))
      : await store.questionsRecentes(jours);
    const mots = motsCles(questions, anonyme ? { limite, minQuestions } : { limite, minPersonnes });
    if (c.req.query("format") === "html") return c.html(nuageHtml(mots, { jours, anonyme }));
    const filtre = anonyme ? { source: "anonymes", minQuestions } : { source: "memoire", minPersonnes };
    return c.json({ jours, questions: questions.length, ...filtre, mots });
  };
}

export function motsClesRoutes() {
  const deps = () => ({ store: botStore(), memoryDays: config().MEMORY_DAYS });
  return [registerApiRoute("/stats/mots-cles", { method: "GET", handler: motsClesHandler(deps) })];
}
