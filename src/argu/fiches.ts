/**
 * Fiches d'objections en brouillon, écrites hors de la consolidation (revue de presse, travail de
 * l'équipe) et importées dans aec_objections pour y être relues et validées.
 *
 * L'import n'écrase jamais rien : une objection qui porte déjà le même intitulé (casse ignorée) est
 * laissée telle quelle, quel que soit son statut. Une fiche importée est toujours un brouillon :
 * seule l'équipe la valide.
 */
import { z } from "zod";
import type { ArguStore } from "./store.js";

const PointProgramme = z.object({
  type: z.literal("programme"),
  titre: z.string().min(1),
  url: z.string().url(),
  page: z.number().int().positive().optional(),
  section: z.string().min(1).optional(),
  /** Recopié mot pour mot du document, pour que l'équipe le retrouve. */
  extrait: z.string().min(1),
  note: z.string().optional(),
});

const PointPresse = z.object({
  type: z.literal("presse"),
  titre: z.string().min(1),
  url: z.string().url(),
  note: z.string().optional(),
});

export const PointAppui = z.discriminatedUnion("type", [PointProgramme, PointPresse]);
export type PointAppui = z.infer<typeof PointAppui>;

export const FicheBrouillon = z.object({
  intitule: z.string().trim().min(1),
  reformulations: z.array(z.string().trim().min(1)).default([]),
  /** Code du référentiel « theme », ou null quand l'objection vise une personne ou la campagne. */
  theme: z.string().nullable().default(null),
  reponse_courte: z.string().trim().min(1),
  reponse_detaillee: z.string().trim().min(1),
  points_appui: z.array(PointAppui).min(1),
});
export type FicheBrouillon = z.infer<typeof FicheBrouillon>;

export const FichiersFiches = z.object({
  _note: z.string().optional(),
  fiches: z.array(FicheBrouillon).min(1),
});

export interface ResultatImport {
  ajoutees: string[];
  existantes: string[];
}

/** Lit et valide un fichier de fiches ; refuse un intitulé en double dans le fichier. */
export function lireFiches(json: unknown): FicheBrouillon[] {
  const { fiches } = FichiersFiches.parse(json);
  const vus = new Set<string>();
  for (const f of fiches) {
    const cle = f.intitule.toLowerCase();
    if (vus.has(cle)) throw new Error(`Intitulé en double dans le fichier : « ${f.intitule} »`);
    vus.add(cle);
  }
  return fiches;
}

export async function importerFiches(store: ArguStore, fiches: FicheBrouillon[]): Promise<ResultatImport> {
  const themes = new Set((await store.referentiel("theme", { actifsSeulement: false })).map((r) => r.code));
  const inconnus = fiches.filter((f) => f.theme !== null && !themes.has(f.theme));
  if (inconnus.length) {
    throw new Error(`Thème inconnu : ${inconnus.map((f) => `« ${f.theme} » (${f.intitule})`).join(", ")}`);
  }
  const resultat: ResultatImport = { ajoutees: [], existantes: [] };
  for (const f of fiches) {
    const ajoutee = await store.insererObjectionBrouillon(f);
    (ajoutee ? resultat.ajoutees : resultat.existantes).push(f.intitule);
  }
  return resultat;
}
