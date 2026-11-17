/**
 * Catégories documentaires. Elles ont des statuts différents et ne doivent
 * jamais être fondues en un seul bloc dans les réponses.
 */
export const CATEGORIES = [
  "programme",
  "livret",
  "plan",
  "publication_2026",
  "page",
  "ajout_manuel",
  "archive",
  "autre",
  /** Fiches d'argumentaire validées par l'équipe : jamais montrées à l'agent `aec` (mode programme). */
  "argumentaire",
] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * Catégories du mode programme : tout sauf l'argumentaire. C'est le filtre par défaut de la
 * recherche ; le futur mode `argu` passera explicitement `["argumentaire"]`.
 */
export const CATEGORIES_PROGRAMME: Category[] = CATEGORIES.filter((c) => c !== "argumentaire");

/**
 * Édition du programme. Tant que le programme 2027 n'est pas publié, l'édition 2022
 * est interrogée aussi, et chaque réponse qui s'en sert le dit (EDITIONS dans .env).
 */
export type Corpus = "aec2027" | "aec2022";

export type Origin = "wordpress" | "manuel";

/** Un document tel que listé par la source, avant téléchargement. */
export interface SourceItem {
  /** Identifiant stable : wp:media:123, wp:page:45, manual:<uuid> */
  id: string;
  origin: Origin;
  kind: "pdf" | "html" | "text";
  title: string;
  url: string;
  /** Date de modification WordPress (ISO). Ce n'est PAS une date de rédaction. */
  modified: string;
  /** Contenu déjà disponible (pages HTML de l'API, textes ajoutés à la main). */
  inlineContent?: string;
  /** Ajouts manuels Telegram : file_id pour renvoyer le PDF. */
  telegramFileId?: string;
  addedBy?: string;
  /** Document déjà extrait par l'appelant (ajout manuel) : pages PDF ou sections d'EPUB. */
  inlinePages?: { page: number; text: string; section?: string }[];
  /** Classement imposé (sources ajoutées hors WordPress, comme l'édition 2022). */
  forced?: { category: Category; corpus: Corpus };
}

/**
 * Texte d'un document, une entrée par page PDF (une seule pour HTML/texte), ou par section
 * pour un EPUB : `page` est alors le rang de la section, et `section` son titre, seul cité.
 */
export interface ExtractedDocument {
  pages: { page: number | null; text: string; section?: string }[];
}

export interface Classification {
  category: Category;
  corpus: Corpus;
  included: boolean;
  reason: string;
  /** Ancienne règle (programme du site marqué provisoire) : faux pour le livre 2026. */
  provisional: boolean;
}

export interface PassageMetadata {
  docId: string;
  title: string;
  url: string;
  page: number | null;
  /** EPUB : chemin de la section (« Partie … › Chapitre … › Section »), cité à la place de la page. */
  section: string | null;
  category: Category;
  corpus: Corpus;
  origin: Origin;
  modified: string;
  provisional: boolean;
  /** Texte du passage : c'est ce que l'outil de recherche renverra à l'agent. */
  text: string;
  [key: string]: unknown;
}
