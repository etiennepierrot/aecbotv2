import type { Classification, ExtractedDocument, SourceItem } from "./types.js";

/**
 * Classement d'après le titre et l'URL, avant de regarder le contenu.
 * Les règles reproduisent les décisions du manifeste de l'ancien pipeline
 * (voir tests/classify.test.ts). L'ordre compte.
 */
export function classifyByMetadata(item: SourceItem): Classification {
  const base = { corpus: "aec2027" as const, provisional: false };
  const hay = `${item.title} ${decodeURIComponent(item.url)}`.toUpperCase();

  if (item.forced) {
    return { ...base, ...item.forced, included: true, reason: "" };
  }
  if (item.origin === "manuel") {
    return { ...base, category: "ajout_manuel", included: true, reason: "" };
  }
  if (item.kind === "html") {
    return { ...base, category: "page", included: true, reason: "" };
  }
  if (/FRONT[-_ ]POPULAIRE|\bNFP\b/.test(hay)) {
    return { ...base, category: "archive", included: false, reason: "Archive NFP 2024 exclue par défaut" };
  }
  if (/DOSSIER[-_ ]DE[-_ ]PRESSE|LETTRE[-_ ]AUX/.test(hay)) {
    return { ...base, category: "autre", included: false, reason: "Document secondaire exclu par défaut" };
  }
  if (/PROGRAMME/.test(hay) && !/ABREGE|FALC/.test(hay)) {
    return { ...base, category: "programme", included: true, reason: "", provisional: true };
  }
  const year = uploadYear(item.url);
  if (year !== undefined && year >= 2026) {
    return { ...base, category: "publication_2026", included: true, reason: "" };
  }
  // Livrets et plans de la campagne 2022 (Union populaire), re-téléversés en 2024 : édition 2022.
  const corpus = isEdition2022(hay) ? ("aec2022" as const) : base.corpus;
  if (/LIVRET/.test(hay)) {
    return { ...base, corpus, category: "livret", included: true, reason: "" };
  }
  if (/PLAN/.test(hay)) {
    return { ...base, corpus, category: "plan", included: true, reason: "" };
  }
  return { ...base, category: "autre", included: false, reason: "Document non classé exclu par défaut" };
}

/**
 * Documents de la campagne 2022 : marqueur « UP » (Union populaire) dans le nom, ou fichiers
 * connus publiés sur melenchon2022.fr (livret Éducation, livret ESR daté 220121).
 */
export function isEdition2022(hay: string): boolean {
  return /(^|[\s_-])UP[_-]/.test(hay) || /LIVRET[-_]EDUCATION[-_]AEC|ASS[-_]LIVRET[-_]ESR/.test(hay);
}

/** Année du dossier wp-content/uploads/AAAA/MM/ */
export function uploadYear(url: string): number | undefined {
  const m = /\/uploads\/(\d{4})\//.exec(url);
  return m?.[1] ? Number(m[1]) : undefined;
}

/** Moins de texte que ça : PDF scanné ou en images, inutilisable. */
const MIN_CHARS_PER_PAGE = 200;
const MIN_CHARS = 500;

export function isExtractionUsable(doc: ExtractedDocument): boolean {
  const chars = doc.pages.reduce((n, p) => n + p.text.trim().length, 0);
  return chars >= MIN_CHARS && chars >= MIN_CHARS_PER_PAGE * Math.min(doc.pages.length, 5);
}

/** Texte normalisé, pour repérer les doublons exacts (même PDF téléversé deux fois). */
export function normalizeForHash(doc: ExtractedDocument): string {
  return doc.pages
    .map((p) => p.text)
    .join("\n")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
