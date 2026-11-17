import { figureDans } from "./citations.js";
import type { ProfilEmetteur, TraitEmetteur } from "./store.js";

/**
 * Règles de garde de la consolidation, appliquées par le code après chaque appel au modèle.
 * Fonctions pures : testées sans base ni modèle.
 */

/**
 * `fake_news` exige une preuve : le type n'est gardé qu'avec une source de vérification (fournie
 * par la capture, ou par un `debunk` déjà validé). Sans elle, il est retiré et l'affirmation est
 * marquée « à vérifier ». La règle vaut dans les deux sens, y compris quand la vérification
 * contredit une affirmation favorable au programme.
 */
export function regleFakeNews(
  types: string[],
  verificationUrl: string | null,
): { types: string[]; aVerifier: boolean; verificationUrl: string | null } {
  if (!types.includes("fake_news")) return { types, aVerifier: false, verificationUrl };
  if (verificationUrl) return { types, aVerifier: false, verificationUrl };
  return { types: types.filter((t) => t !== "fake_news"), aVerifier: true, verificationUrl: null };
}

export const INDETERMINE = "indetermine";

/** Ce qui, dans la capture, peut fonder une déduction sur l'émetteur. */
export interface SourcesEmetteur {
  texte: string;
  auteurNom?: string | null;
  auteurIdentifiant?: string | null;
  /** Bio ou description de la chaîne, quand l'extension l'a capturée. */
  bio?: string | null;
}

/**
 * Un trait de l'émetteur n'est gardé que si son code existe dans le référentiel et que son indice
 * figure mot pour mot dans la capture : jamais de déduction sur le seul nom, une photo ou un
 * stéréotype. Sinon il devient « indetermine ».
 */
export function verifierTrait(trait: TraitEmetteur, codesValides: string[], sources: SourcesEmetteur): TraitEmetteur {
  if (trait.code === INDETERMINE) return { ...trait, indice: null };
  const codeConnu = codesValides.includes(trait.code);
  // Le nom affiché seul ne fonde rien : l'indice doit apporter une information.
  const indiceValable =
    figureDans(trait.indice, sources.texte, sources.bio) ||
    (figureDans(trait.indice, sources.auteurNom, sources.auteurIdentifiant) &&
      normaliserNom(trait.indice) !== normaliserNom(sources.auteurNom) &&
      normaliserNom(trait.indice) !== normaliserNom(sources.auteurIdentifiant));
  if (codeConnu && indiceValable) return trait;
  return {
    code: INDETERMINE,
    justification: codeConnu ? "indice introuvable dans la capture" : `code inconnu du référentiel (${trait.code})`,
    indice: null,
    origine: "deduit",
  };
}

const normaliserNom = (s: string | null | undefined) => (s ?? "").normalize("NFC").replace(/^@/, "").trim().toLowerCase();

export function verifierProfil(
  profil: Omit<ProfilEmetteur, "modele" | "evalue_le">,
  referentiels: { classes: string[]; familles: string[] },
  sources: SourcesEmetteur,
): Omit<ProfilEmetteur, "modele" | "evalue_le"> {
  return {
    classe_sociale: verifierTrait(profil.classe_sociale, referentiels.classes, sources),
    orientation: verifierTrait(profil.orientation, referentiels.familles, sources),
  };
}
