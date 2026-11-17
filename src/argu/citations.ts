/**
 * Vérification des citations, sans modèle : une affirmation n'est gardée que si son extrait se
 * retrouve mot pour mot dans la capture. Même principe que verifyAnswer pour l'agent : le modèle
 * propose, le code vérifie. C'est la garantie contre la fausse attribution.
 */

/** Comparaison tolérante à la typographie seulement : espaces, apostrophes et guillemets, forme Unicode. */
export function normaliserPourComparer(texte: string): string {
  return texte
    .normalize("NFC")
    .replace(/[‘’ʼ′`´]/g, "'")
    .replace(/[“”«»„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    // Les espaces (insécables compris) disparaissent autour des guillemets français : « x » = "x".
    .replace(/"\s+/g, '"')
    .replace(/\s+"/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Vrai si `extrait` (non vide) figure mot pour mot dans l'une des sources. */
export function figureDans(extrait: string | null | undefined, ...sources: (string | null | undefined)[]): boolean {
  const e = normaliserPourComparer(extrait ?? "");
  if (e.length < 3) return false;
  return sources.some((s) => !!s && normaliserPourComparer(s).includes(e));
}
