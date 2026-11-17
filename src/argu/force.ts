/**
 * Les deux critères de force calculés par le code (spec, « La force, en quatre critères ») :
 * la fréquence (combien d'affirmations portent la même objection) et la portée (quelle audience
 * a l'émetteur). Les deux autres, appui factuel et difficulté de réponse, viennent du modèle.
 */

export interface Note {
  note: number;
  justification: string;
}

export interface Force {
  appui_factuel: Note;
  difficulte_reponse: Note;
  frequence: Note;
  portee: Note;
}

/** 1 affirmation → 1 ; 2 → 2 ; 3-4 → 3 ; 5-9 → 4 ; 10 et plus → 5. */
export function noteFrequence(n: number): Note {
  const note = n >= 10 ? 5 : n >= 5 ? 4 : n >= 3 ? 3 : n >= 2 ? 2 : 1;
  return { note, justification: n <= 1 ? "première occurrence" : `${n} affirmations portent la même objection` };
}

const BASE_PORTEE: Record<string, number> = { personnalite: 4, media: 4, organisation: 3, particulier: 1, inconnu: 2 };

/**
 * Note de base selon le type d'émetteur, remplacée par l'audience quand l'extension l'a capturée
 * (`extras.audience` ou `extras.abonnes`, un nombre).
 */
export function notePortee(auteurType: string | null | undefined, extras: Record<string, unknown> = {}): Note {
  const audience = Number(extras.audience ?? extras.abonnes);
  if (Number.isFinite(audience) && audience > 0) {
    const note = audience >= 1_000_000 ? 5 : audience >= 100_000 ? 4 : audience >= 10_000 ? 3 : audience >= 1_000 ? 2 : 1;
    return { note, justification: `audience capturée : ${audience.toLocaleString("fr-FR")}` };
  }
  const type = auteurType ?? "inconnu";
  return { note: BASE_PORTEE[type] ?? 2, justification: `type d'émetteur : ${type}, audience inconnue` };
}
