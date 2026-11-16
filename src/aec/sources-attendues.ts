/** Une source attendue pour une question type : titre contenant `document`, page parmi `pages`. */
export interface SourceAttendue {
  document: string;
  pages?: number[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Le document `title` (aux pages `pages`) correspond-il à une source attendue ?
 * Sans pages attendues, n'importe quelle page du document compte.
 * Partagé par le scorer « source attendue » (réponse) et l'éval de la recherche.
 */
export function correspondA(title: string, pages: (number | null)[], attendue: SourceAttendue): boolean {
  if (!norm(title).includes(norm(attendue.document))) return false;
  if (!attendue.pages?.length) return true;
  return pages.some((p) => p !== null && attendue.pages!.includes(p));
}
