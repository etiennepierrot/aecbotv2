import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { analyser, type Etat, evaluer, marquerErreur, preparer, rapprocher, regrouperEtEnregistrer } from "../../argu/consolidation.js";
import { consolidationDeps } from "../../argu/deps.js";

/**
 * Workflow `consolidation` : lancé à chaque capture, il en tire des affirmations en brouillon.
 * Une étape par phase (src/argu/consolidation.ts), pour suivre chaque capture dans Studio.
 * Il ne publie jamais rien : la validation est humaine.
 */

const entree = z.object({ captureId: z.string(), relance: z.boolean().default(false) });
// Les brouillons circulent tels quels d'une étape à l'autre ; leur forme est typée par Etat.
const etat = z.object({
  captureId: z.string(),
  arret: z.string().nullable(),
  auteurType: z.string(),
  brouillons: z.array(z.any()),
  citationsRejetees: z.number(),
});
const sortie = etat.extend({ ids: z.array(z.string()) });

/** Toute panne fait passer la capture en erreur (relançable par `pnpm argu relancer`). */
const garde = <T>(captureId: string, f: () => Promise<T>) =>
  f().catch(async (e) => {
    await marquerErreur({ store: (await consolidationDeps()).store }, captureId, e);
    throw e;
  });

const phase = (id: string, description: string, f: (d: Awaited<ReturnType<typeof consolidationDeps>>, e: Etat) => Promise<Etat>) =>
  createStep({
    id,
    description,
    inputSchema: etat,
    outputSchema: etat,
    execute: async ({ inputData }) => garde(inputData.captureId, async () => f(await consolidationDeps(), inputData as Etat)),
  });

const preparerStep = createStep({
  id: "preparer",
  description: "Plafond quotidien, nettoyage du texte, refus d'un lien seul.",
  inputSchema: entree,
  outputSchema: etat,
  execute: async ({ inputData }) =>
    garde(inputData.captureId, async () => preparer(await consolidationDeps(), inputData.captureId, { relance: inputData.relance })),
});

const enregistrerStep = createStep({
  id: "regrouper-enregistrer",
  description: "Objections proches proposées, règle fake_news, brouillons enregistrés, équipe prévenue.",
  inputSchema: etat,
  outputSchema: sortie,
  execute: async ({ inputData }) =>
    garde(inputData.captureId, async () => regrouperEtEnregistrer(await consolidationDeps(), inputData as Etat)),
});

export const consolidationWorkflow = createWorkflow({
  id: "consolidation",
  description: "Capture → affirmations classées, évaluées et rapprochées du programme, en brouillon.",
  inputSchema: entree,
  outputSchema: sortie,
})
  .then(preparerStep)
  .then(phase("analyser", "Extraction des affirmations, citations vérifiées, profil de l'émetteur.", analyser))
  .then(phase("rapprocher", "Passages du programme proches de chaque affirmation.", rapprocher))
  .then(phase("evaluer", "Force (appui factuel, difficulté de réponse, portée) et publics.", evaluer))
  .then(enregistrerStep)
  .commit();
