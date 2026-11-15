import { config, PASSAGES_INDEX } from "../config.js";
import { retrievalDeps } from "../corpus/deps.js";

export interface SuiteScore {
  question: string;
  /** Similarité du passage le plus proche dans l'index (cosinus, 0 à 1). */
  score: number;
}

/**
 * Score de chaque question : la similarité de son meilleur passage dans les éditions
 * interrogées. Un seul appel d'embeddings pour toutes les questions.
 */
export async function scoreQuestions(questions: string[]): Promise<SuiteScore[]> {
  if (questions.length === 0) return [];
  const { embedder, vector } = await retrievalDeps();
  const vectors = await embedder.embed(questions);
  const filter = { corpus: { $in: config().EDITIONS } };
  const scores: SuiteScore[] = new Array(questions.length);
  let next = 0;
  // Pas plus de QUERY_CONCURRENCY requêtes à la fois : le pool de PgVector (~20 connexions,
  // court délai d'attente) lâche « timeout exceeded when trying to connect » au-delà, surtout
  // vers une base distante (calibrage sur toutes les questions d'évals).
  const worker = async () => {
    while (next < questions.length) {
      const i = next++;
      const question = questions[i]!;
      const queryVector = vectors[i];
      if (!queryVector) {
        scores[i] = { question, score: 0 };
        continue;
      }
      const [best] = await vector.query({ indexName: PASSAGES_INDEX, queryVector, topK: 1, filter: filter as never });
      scores[i] = { question, score: best?.score ?? 0 };
    }
  };
  await Promise.all(Array.from({ length: Math.min(QUERY_CONCURRENCY, questions.length) }, worker));
  return scores;
}

const QUERY_CONCURRENCY = 5;

/**
 * Ne garde que les suites que le corpus permet de servir : celles dont un passage est
 * assez proche (SUITES_MIN_SCORE). En cas de panne, aucune suite : mieux vaut ne rien
 * proposer que proposer une question sans réponse.
 */
export async function filtrerSuites(
  suites: string[],
  minScore = config().SUITES_MIN_SCORE,
): Promise<{ gardees: string[]; retirees: number }> {
  if (suites.length === 0) return { gardees: [], retirees: 0 };
  try {
    const scores = await scoreQuestions(suites);
    const gardees = scores.filter((s) => s.score >= minScore).map((s) => s.question);
    return { gardees, retirees: suites.length - gardees.length };
  } catch {
    return { gardees: [], retirees: suites.length };
  }
}
