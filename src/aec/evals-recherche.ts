/**
 * Éval de la recherche seule, sans LLM : pour chaque question type, la recherche
 * remonte-t-elle une des sources attendues, et à quel rang ?
 *
 * Rapide et presque gratuite (un embedding par question) : c'est l'outil pour régler
 * le découpage, les quotas par édition, la recherche hybride ou un reranking.
 */
import type { EvalQuestion } from "./evals.js";
import { correspondA } from "./sources-attendues.js";
import { sectionTitle } from "../corpus/epub.js";
import type { RetrievedPassage } from "./types.js";

export type Recherche = (requete: string) => Promise<RetrievedPassage[]>;

export interface ResultatRecherche {
  id: string;
  question: string;
  attendu: EvalQuestion["attendu"];
  /** Rang (1 = premier) de la première page qui correspond à une source attendue ; null si aucune. */
  rang: number | null;
  /** Part des sources attendues trouvées dans les résultats (une source = un document, et ses pages s'il y en a). */
  couverture: number | null;
  /** Score de la première page pertinente. */
  scorePertinent: number | null;
  /** Meilleur score, pertinent ou non : sert à calibrer un seuil (questions hors corpus). */
  scoreMax: number | null;
  /** Les premiers résultats, pour comprendre un échec. */
  top: { rang: number; titre: string; page: number | null; score: number; pertinent: boolean }[];
  erreur?: string;
}

export interface RapportRecherche {
  topK: number;
  questions: ResultatRecherche[];
  /** Questions qui ont une réponse et des sources attendues. */
  evaluees: number;
  /** recall@k : part des questions dont une source attendue est dans les k premiers résultats. */
  recall: Record<number, number>;
  /** Moyenne de 1/rang (0 si aucune source attendue n'est trouvée). */
  mrr: number;
  couvertureMoyenne: number;
  /** Meilleur score par question : sur les questions avec réponse, et sur les questions hors corpus. */
  scoresMax: { repondu: number[]; introuvable: number[] };
}

export const KS = [1, 3, 5, 10, 20];

export async function evaluerRecherche(
  questions: EvalQuestion[],
  recherche: Recherche,
  opts: { topK: number; concurrence?: number; onProgress?: (r: ResultatRecherche) => void },
): Promise<RapportRecherche> {
  const resultats: ResultatRecherche[] = new Array(questions.length);
  let next = 0;
  const worker = async () => {
    while (next < questions.length) {
      const i = next++;
      resultats[i] = await evaluerQuestion(questions[i]!, recherche);
      opts.onProgress?.(resultats[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrence ?? 4) }, worker));
  return resumer(resultats, opts.topK);
}

export async function evaluerQuestion(q: EvalQuestion, recherche: Recherche): Promise<ResultatRecherche> {
  const base = { id: q.id, question: q.question, attendu: q.attendu };
  let found: RetrievedPassage[];
  try {
    found = await recherche(q.question);
  } catch (e) {
    // Une panne compte comme un échec, pas comme une question écartée : sinon le recall monterait.
    const evaluable = q.attendu === "repondu" && !!q.sources?.length;
    return {
      ...base, rang: null, couverture: evaluable ? 0 : null, scorePertinent: null, scoreMax: null, top: [],
      erreur: e instanceof Error ? e.message : String(e),
    };
  }
  const attendues = q.attendu === "repondu" ? (q.sources ?? []) : [];
  const pertinent = (p: RetrievedPassage) => attendues.some((a) => correspondA(p.title, [p.page], a, [p.section]));
  const idx = found.findIndex(pertinent);
  return {
    ...base,
    rang: attendues.length && idx >= 0 ? idx + 1 : null,
    couverture: attendues.length
      ? attendues.filter((a) => found.some((p) => correspondA(p.title, [p.page], a, [p.section]))).length / attendues.length
      : null,
    scorePertinent: idx >= 0 ? found[idx]!.score : null,
    scoreMax: found.length ? Math.max(...found.map((p) => p.score)) : null,
    top: found.slice(0, 5).map((p, i) => ({ rang: i + 1, titre: p.section ? `${p.title} › ${sectionTitle(p.section)}` : p.title, page: p.page, score: p.score, pertinent: pertinent(p) })),
  };
}

export function resumer(questions: ResultatRecherche[], topK: number): RapportRecherche {
  const evaluees = questions.filter((r) => r.attendu === "repondu" && r.couverture !== null);
  const n = evaluees.length || 1;
  const ks = KS.filter((k) => k <= topK);
  const recall = Object.fromEntries(ks.map((k) => [k, evaluees.filter((r) => r.rang !== null && r.rang <= k).length / n]));
  const scores = (attendu: EvalQuestion["attendu"]) =>
    questions.filter((r) => r.attendu === attendu && r.scoreMax !== null).map((r) => r.scoreMax!);
  return {
    topK,
    questions,
    evaluees: evaluees.length,
    recall,
    mrr: evaluees.reduce((s, r) => s + (r.rang ? 1 / r.rang : 0), 0) / n,
    couvertureMoyenne: evaluees.reduce((s, r) => s + r.couverture!, 0) / n,
    scoresMax: { repondu: scores("repondu"), introuvable: scores("introuvable") },
  };
}
