/**
 * Jeu de données pour calibrer le filtre des suites (SUITES_MIN_SCORE) : evals/suites.json.
 * Fonctions pures ici ; la génération (LLM, base) est dans scripts/suites-donnees.ts.
 */
import { extractSuites } from "./verify.js";

export type Verdict = "repondu" | "partiel" | "introuvable";
export type Origine = "reelle" | "passage" | "voisine";

export interface SuiteDonnee {
  id: string;
  question: string;
  /** Étiquette retenue. Le calibrage n'utilise que « repondu » et « introuvable ». */
  attendu: Verdict;
  /** reelle : suite proposée par le bot en production ; passage : écrite à partir d'un passage ; voisine : sujet proche, a priori absent. */
  origine: Origine;
  /** Passage d'où vient la question (origine « passage »). Jamais la question d'un utilisateur. */
  contexte?: string;
  juge?: { verdict: Verdict; raison: string };
  /** À relire à la main : le juge contredit l'étiquette prévue, ou il hésite (« partiel »). Mettre à false après relecture. */
  aRelire: boolean;
}

/** Texte brut de la réponse du modèle dans la sortie d'un span racine d'agent (chaîne, ou objet { text }). */
export function texteDeSortie(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && typeof (output as { text?: unknown }).text === "string") {
    return (output as { text: string }).text;
  }
  return undefined;
}

/** Les suites proposées par le modèle, avant filtrage, d'après la sortie brute d'une trace. */
export function suitesDeSortie(output: unknown): string[] {
  const texte = texteDeSortie(output);
  return texte ? extractSuites(texte).suites : [];
}

export function normaliser(question: string): string {
  return question
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Identifiant lisible et stable : origine + premiers mots de la question. */
export function idPour(origine: Origine, question: string, pris: Set<string>): string {
  const base = `${origine}-${normaliser(question).split(" ").slice(0, 6).join("-")}`.slice(0, 60);
  let id = base;
  for (let n = 2; pris.has(id); n++) id = `${base}-${n}`;
  pris.add(id);
  return id;
}

/** L'étiquette prévue par l'origine ; pour une suite réelle, pas d'a priori : on suit le juge. */
export function etiqueter(origine: Origine, juge: { verdict: Verdict; raison: string }): Pick<SuiteDonnee, "attendu" | "aRelire"> {
  const prevu: Verdict | undefined = origine === "passage" ? "repondu" : origine === "voisine" ? "introuvable" : undefined;
  return {
    attendu: prevu ?? juge.verdict,
    aRelire: juge.verdict === "partiel" || (prevu !== undefined && juge.verdict !== prevu),
  };
}

/** Ajoute les nouvelles entrées sans doublon (même question normalisée) : l'existant, peut-être relu, prime. */
export function fusionner(existant: SuiteDonnee[], nouvelles: SuiteDonnee[]): { donnees: SuiteDonnee[]; ajoutees: number } {
  const vues = new Set(existant.map((d) => normaliser(d.question)));
  const donnees = [...existant];
  for (const d of nouvelles) {
    const k = normaliser(d.question);
    if (vues.has(k)) continue;
    vues.add(k);
    donnees.push(d);
  }
  return { donnees, ajoutees: donnees.length - existant.length };
}

/** Exécute `fn` sur chaque élément, `n` à la fois au plus, en gardant l'ordre des résultats. */
export async function enParallele<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

export interface LigneSeuil {
  seuil: number;
  /** Introuvables au-dessus du seuil : suites proposées à tort. */
  fauxPositifs: number;
  /** Répondues sous le seuil : bonnes suites retirées. */
  retirees: number;
}

/** Pour chaque seuil candidat (chaque score observé, et juste au-dessus), les deux types d'erreur. */
export function tableauSeuils(repondu: number[], introuvable: number[]): LigneSeuil[] {
  const candidats = [...new Set([...repondu, ...introuvable].flatMap((s) => [s, s + 0.001]).map((s) => Math.round(s * 1000) / 1000))].sort(
    (a, b) => a - b,
  );
  return candidats.map((seuil) => ({
    seuil,
    fauxPositifs: introuvable.filter((s) => s >= seuil).length,
    retirees: repondu.filter((s) => s < seuil).length,
  }));
}
