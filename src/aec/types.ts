import type { Category, Corpus } from "../corpus/types.js";

/** Un passage renvoyé par la recherche vectorielle. */
export interface RetrievedPassage {
  id: string;
  score: number;
  docId: string;
  title: string;
  url: string;
  page: number | null;
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
  title: string;
  url: string;
  /** Pages citées, dans l'ordre (vide pour une page web). */
  pages: number[];
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
  };
}

export const INTROUVABLE_TEXTE =
  "Je ne trouve rien sur ce sujet dans le programme ni dans les livrets. " +
  "Je préfère ne pas répondre plutôt que d'inventer.";
