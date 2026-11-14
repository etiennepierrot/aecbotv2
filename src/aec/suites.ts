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
  return Promise.all(
    questions.map(async (question, i) => {
      const queryVector = vectors[i];
      if (!queryVector) return { question, score: 0 };
      const [best] = await vector.query({ indexName: PASSAGES_INDEX, queryVector, topK: 1, filter: filter as never });
      return { question, score: best?.score ?? 0 };
    }),
  );
}

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
