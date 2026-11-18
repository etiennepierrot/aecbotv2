import type { Mastra } from "@mastra/core";
import { registerApiRoute } from "@mastra/core/server";
import type { Context } from "hono";
import { enregistrerCapture, type CaptureDeps } from "../../argu/capture.js";
import { arguStore } from "../../argu/deps.js";
import { verifierJeton } from "../../argu/jetons.js";
import { SELECTEURS } from "../../argu/selecteurs.js";
import type { ArguStore } from "../../argu/store.js";
import { config } from "../../config.js";

/**
 * POST /capture : point d'entrée de l'extension Chrome/Opera. Publique comme /telegram (hors de
 * /api/*), mais protégée par le jeton personnel obtenu avec /jeton : la route le vérifie elle-même.
 * GET /capture/config : les sélecteurs DOM de X et YouTube, avec le même jeton.
 */

export interface CaptureRouteDeps extends Omit<CaptureDeps, "store"> {
  store: Pick<ArguStore, "insererCapture" | "jetonActif" | "capturesRecentes">;
  maxParJeton: number;
}

/** Au-delà, le corps n'est même pas lu : 50 000 caractères de texte tiennent largement dedans. */
const CORPS_MAX_OCTETS = 1_000_000;

export function captureHandler(deps: () => CaptureRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const d = deps();
    const pseudo = await verifierJeton(d.store, c.req.header("authorization"));
    if (!pseudo) return c.json({ erreur: "jeton absent, inconnu ou révoqué" }, 401);

    if (Number(c.req.header("content-length") ?? 0) > CORPS_MAX_OCTETS) {
      return c.json({ erreur: "corps trop gros", champ: null }, 413);
    }
    if ((await d.store.capturesRecentes(pseudo, "extension")) >= d.maxParJeton) {
      return c.json({ erreur: `plus de ${d.maxParJeton} captures en 24 h pour ce jeton` }, 429);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ erreur: "JSON invalide", champ: null }, 422);
    }
    const r = await enregistrerCapture(body, { capturePar: pseudo, canal: "extension" }, d);
    if (!r.ok) return c.json({ erreur: r.message, champ: r.champ }, r.code);
    return r.doublon ? c.json({ id: r.id, statut: "doublon" }, 200) : c.json({ id: r.id, statut: "recue" }, 201);
  };
}

export function captureConfigHandler(deps: () => Pick<CaptureRouteDeps, "store">) {
  return async (c: Context): Promise<Response> => {
    const pseudo = await verifierJeton(deps().store, c.req.header("authorization"));
    if (!pseudo) return c.json({ erreur: "jeton absent, inconnu ou révoqué" }, 401);
    return c.json(SELECTEURS);
  };
}

type Logger = { error: (msg: string, meta?: object) => void };

/** Lance le workflow consolidation sur une capture, sans l'attendre. */
export function lanceur(mastra: Mastra) {
  return async (captureId: string, relance = false) => {
    const run = await mastra.getWorkflow("consolidation").createRun();
    return run.start({ inputData: { captureId, relance } });
  };
}

export function captureRoutes(logger?: Logger) {
  const deps = (mastra?: Mastra) => (): CaptureRouteDeps => ({
    store: arguStore(),
    maxParJeton: config().CAPTURE_MAX_PER_TOKEN,
    logger,
    lancerConsolidation: mastra ? lanceur(mastra) : undefined,
  });
  return [
    registerApiRoute("/capture", {
      method: "POST",
      requiresAuth: false,
      createHandler: async ({ mastra }) => captureHandler(deps(mastra)),
    }),
    registerApiRoute("/capture/config", { method: "GET", requiresAuth: false, handler: captureConfigHandler(deps()) }),
  ];
}
