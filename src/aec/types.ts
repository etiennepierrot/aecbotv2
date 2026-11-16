import type { Category, Corpus } from "../corpus/types.js";

/** Un passage renvoyé par la recherche vectorielle. */
export interface RetrievedPassage {
  id: string;
  score: number;
  docId: string;
  title: string;
  url: string;
  page: number | null;
  /** EPUB : chemin de la section, cité à la place de la page. */
  section: string | null;
  category: Category;
  corpus: Corpus;
  provisional: boolean;
  text: string;
}

/** Un passage tel que l'agent l'a reçu, avec sa référence courte (P1, P2…). */
export interface ReferencedPassage extends RetrievedPassage {
  ref: string;
}

/** Un document cité ; plusieurs pages d'un même document partagent son numéro. */
export interface Source {
  n: number;
  docId: string;
  title: string;
  url: string;
  /** Pages citées, dans l'ordre (vide pour une page web). */
  pages: number[];
  /** EPUB : sections citées (chemins complets), dans l'ordre du livre. */
  sections: string[];
  category: Category;
  corpus: Corpus;
  provisional: boolean;
}

export interface Answer {
  statut: "repondu" | "introuvable";
  /** Texte avec des appels [1], [2]… renvoyant à `sources`. */
  texte: string;
  sources: Source[];
  avertissements: string[];
  /** Questions d'approfondissement proposées (3 au plus), sans références. */
  suites?: string[];
  /** Ce que la vérification a corrigé : sert aux évals et aux traces. */
  controle: {
    passagesRecuperes: number;
    citationsValides: number;
    citationsRejetees: number;
    phrasesRetirees: number;
    phrasesSansSource: number;
    /** Suites proposées par le modèle mais écartées : le corpus ne permettrait pas d'y répondre. */
    suitesRetirees?: number;
    /** Suites écartées parce qu'elles ne citent aucun passage renvoyé par la recherche. */
    suitesSansPassage?: number;
    /**
     * Réponse partielle (« Je ne trouve pas de passage qui réponde précisément… ») : les passages
     * cités traitent-ils de l'objet précis de la question ? « non » : la réponse devient introuvable.
     */
    objet?: { verdict: "oui" | "non" | "erreur"; objet?: string; raison?: string };
  };
}

export const INTROUVABLE_TEXTE =
  "Je ne trouve rien sur ce sujet dans le programme ni dans les livrets. " +
  "Je préfère ne pas répondre plutôt que d'inventer.";
