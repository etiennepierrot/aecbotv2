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
    // Les « Comparateurs » résument le programme d'AUTRES partis : jamais dans le corpus,
    // sinon l'agent pourrait attribuer leurs mesures à L'Avenir en commun. Reconnus aussi à
    // leur adresse : « Chantier cadre : Retrouver les moyens d'agir… » est une page du
    // Comparateur Place Publique 2025 sans le mot dans son titre.
    if (/^\s*COMPARATEUR\b/.test(item.title.toUpperCase()) || /\/comparateur-/i.test(item.url)) {
      return { ...base, category: "autre", included: false, reason: "Comparateur avec le programme d'un autre parti" };
    }
    // La « Synthèse des contributions » (juillet 2026, 18 chapitres) a précédé le livre :
    // une ancienne version du programme, qui ne fait plus foi.
    if (/\/programme\/synthese-des-contributions\//i.test(item.url)) {
      return { ...base, category: "programme", included: false, reason: SYNTHESE };
    }
    // Articles : seuls les chapitres et chantiers du programme ; les tribunes et réactions
    // à l'actualité publiées sous /programme/ ne sont pas le programme.
    if (item.id.startsWith("wp:post:") && !/^\s*(CHAPITRE|CHANTIER)\b/.test(item.title.toUpperCase())) {
      return { ...base, category: "autre", included: false, reason: "Article d'actualité exclu par défaut" };
    }
    return { ...base, category: "page", included: true, reason: "" };
  }
  if (/FRONT[-_ ]POPULAIRE|\bNFP\b/.test(hay)) {
    return { ...base, category: "archive", included: false, reason: "Archive NFP 2024 exclue par défaut" };
  }
  if (/DOSSIER[-_ ]DE[-_ ]PRESSE|LETTRE[-_ ]AUX/.test(hay)) {
    return { ...base, category: "autre", included: false, reason: "Document secondaire exclu par défaut" };
  }
  // Le programme fait foi dans sa version livre (EPUB 2026, ajouté par `pnpm docs livre`) :
  // les anciennes versions publiées sur le site (PROGRAMME SITE 2025…) ne sont plus interrogées.
  // Les livrets et plans, eux, restent valables.
  if (/PROGRAMME/.test(hay) && !/ABREGE|FALC/.test(hay)) {
    return { ...base, category: "programme", included: false, reason: ANCIEN_PROGRAMME, provisional: true };
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

export const ANCIEN_PROGRAMME = "Ancienne version du programme, remplacée par le livre 2026";
export const SYNTHESE = "Synthèse des contributions, remplacée par le livre 2026";

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
