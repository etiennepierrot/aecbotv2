/**
 * Une source attendue pour une question type : titre contenant `document`, page parmi `pages`
 * (PDF), ou section dont le chemin contient l'un des `sections` (EPUB du programme).
 */
export interface SourceAttendue {
  document: string;
  pages?: number[];
  sections?: string[];
}

const norm = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Le document `title` (aux pages `pages`, ou sections `sections`) correspond-il à une source attendue ?
 * Sans pages ni sections attendues, n'importe quelle partie du document compte.
 * Partagé par le scorer « source attendue » (réponse) et l'éval de la recherche.
 */
export function correspondA(
  title: string,
  pages: (number | null)[],
  attendue: SourceAttendue,
  sections: (string | null)[] = [],
): boolean {
  if (!norm(title).includes(norm(attendue.document))) return false;
  if (attendue.sections?.length) {
    return sections.some((s) => s !== null && attendue.sections!.some((a) => norm(s).includes(norm(a))));
  }
  if (!attendue.pages?.length) return true;
  return pages.some((p) => p !== null && attendue.pages!.includes(p));
}
