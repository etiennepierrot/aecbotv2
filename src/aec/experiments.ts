/**
 * Les questions types comme dataset Mastra, et une passe d'évals comme experiment :
 * chaque passe (un modèle, un prompt) est enregistrée en base avec réponses, scores
 * et traces, consultable et comparable dans Studio (onglet Datasets → Experiments).
 */
import type { Mastra } from "@mastra/core";
import type { Dataset } from "@mastra/core/datasets";
import { repondre, type RepondreResult } from "./repondre.js";
import { summarize, type EvalQuestion, type EvalReport, type Prix, type QuestionResult } from "./evals.js";
import type { Attendu, ScoredRun } from "../mastra/scorers/index.js";
import { citationsScorer, fideliteScorer, sourceAttendueScorer, statutScorer } from "../mastra/scorers/index.js";

export const QUESTIONS_DATASET_ID = "aec-questions-types";

/** Ce que l'experiment enregistre pour chaque question (sortie de la tâche). */
export interface ExperimentOutput extends ScoredRun {
  usage: RepondreResult["usage"];
}

type ItemMetadata = {
  qid: string;
  note?: string;
};

function toPayload(q: EvalQuestion) {
  const groundTruth: Attendu = { attendu: q.attendu, ...(q.sources ? { sources: q.sources } : {}) };
  const metadata: ItemMetadata = { qid: q.id, ...(q.note ? { note: q.note } : {}) };
  return { input: { question: q.question }, groundTruth, metadata };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function allItems(dataset: Dataset) {
  const items = [];
  for (let page = 0; ; page++) {
    const res = await dataset.listItems({ page, perPage: 100 });
    if (Array.isArray(res)) return res;
    items.push(...res.items);
    if (!res.pagination.hasMore) return items;
  }
}

/**
 * Aligne le dataset sur le fichier JSON (source de vérité, versionnée dans git) :
 * ajoute, met à jour, retire. Chaque modification crée une nouvelle version du
 * dataset, donc les anciens experiments restent rattachés aux questions d'alors.
 */
export async function syncQuestionsDataset(
  mastra: Mastra,
  questions: EvalQuestion[],
  opts: { id?: string; name?: string; description?: string } = {},
): Promise<{ dataset: Dataset; ajoutees: number; modifiees: number; retirees: number }> {
  const id = opts.id ?? QUESTIONS_DATASET_ID;
  let dataset: Dataset;
  try {
    dataset = await mastra.datasets.get({ id });
  } catch {
    dataset = await mastra.datasets.create({
      id,
      name: opts.name ?? "Questions types",
      description: opts.description ?? "evals/questions.json : questions avec statut et sources attendus.",
      targetType: "agent",
      targetIds: ["aec"],
      scorerIds: [citationsScorer.id, statutScorer.id, sourceAttendueScorer.id, fideliteScorer.id],
    });
  }

  const existing = new Map<string, Awaited<ReturnType<typeof allItems>>[number]>();
  for (const item of await allItems(dataset)) {
    const qid = (item.metadata as ItemMetadata | undefined)?.qid;
    if (qid) existing.set(qid, item);
  }

  const toAdd = [];
  let modifiees = 0;
  for (const q of questions) {
    const payload = toPayload(q);
    const item = existing.get(q.id);
    existing.delete(q.id);
    if (!item) {
      toAdd.push(payload);
    } else if (!same(item.input, payload.input) || !same(item.groundTruth, payload.groundTruth) || !same(item.metadata, payload.metadata)) {
      await dataset.updateItem({ itemId: item.id, ...payload });
      modifiees++;
    }
  }
  if (toAdd.length) await dataset.addItems({ items: toAdd });
  const retirees = [...existing.values()].map((i) => i.id);
  if (retirees.length) await dataset.deleteItems({ itemIds: retirees });

  return { dataset, ajoutees: toAdd.length, modifiees, retirees: retirees.length };
}

/**
 * Une passe d'évals pour un modèle, en experiment Mastra. La tâche passe par
 * `repondre()` (agent + vérification des citations), pas par l'agent nu :
 * c'est la réponse vérifiée qu'on note, comme le bot la sert.
 */
export async function runModelExperiment(args: {
  dataset: Dataset;
  model: string;
  prix?: Prix;
  juge?: boolean;
  name?: string;
  maxConcurrency?: number;
  repondreImpl?: typeof repondre;
  onProgress?: (r: QuestionResult) => void;
}): Promise<{ experimentId: string; report: EvalReport }> {
  const answer = args.repondreImpl ?? repondre;
  const scorers = [citationsScorer, statutScorer, sourceAttendueScorer, ...(args.juge ? [fideliteScorer] : [])];

  const summary = await args.dataset.startExperiment<{ question: string }, ExperimentOutput, Attendu>({
    name: args.name ?? args.model,
    metadata: { model: args.model, juge: Boolean(args.juge) },
    maxConcurrency: args.maxConcurrency ?? 3,
    scorers,
    task: async ({ input }) => {
      const res = await answer(input.question, { model: args.model });
      return { reponse: res.reponse, passages: res.passages, usage: res.usage };
    },
    afterEach: ({ result }) => {
      args.onProgress?.(toQuestionResult(result));
    },
  });

  const results = summary.results.map(toQuestionResult);
  return { experimentId: summary.experimentId, report: summarize(args.model, results, args.prix) };
}

type ItemWithScores = Awaited<ReturnType<Dataset["startExperiment"]>>["results"][number];

/** Ramène un résultat d'experiment au format de la grille de décision. */
export function toQuestionResult(item: ItemWithScores): QuestionResult {
  const meta = item.metadata as ItemMetadata | undefined;
  const question = (item.input as { question?: string } | null)?.question ?? "";
  const attendu = (item.groundTruth as Attendu | null)?.attendu ?? "repondu";
  const base = { id: meta?.qid ?? item.itemId, question, attendu };
  const output = item.output as ExperimentOutput | null;

  const scorerError = item.scores.find((s) => s.error);
  if (item.error || !output || scorerError) {
    return {
      ...base, scores: {}, citationsRejetees: 0, inputTokens: 0, outputTokens: 0,
      erreur: item.error?.message ?? (scorerError ? `scorer ${scorerError.scorerId} : ${scorerError.error}` : "sortie vide"),
    };
  }

  const score = (id: string) => item.scores.find((s) => s.scorerId === id)?.score ?? undefined;
  return {
    ...base,
    statut: output.reponse.statut,
    texte: output.reponse.texte,
    scores: {
      citations: score(citationsScorer.id),
      statut: score(statutScorer.id),
      sourceAttendue: score(sourceAttendueScorer.id),
      fidelite: score(fideliteScorer.id),
    },
    fideliteRaison: item.scores.find((s) => s.scorerId === fideliteScorer.id)?.reason || undefined,
    citationsRejetees: output.reponse.controle.citationsRejetees,
    objet: output.reponse.controle.objet,
    inputTokens: output.usage.inputTokens,
    outputTokens: output.usage.outputTokens,
  };
}

export interface Ecart {
  qid: string;
  question: string;
  /** Statut et fidélité par experiment (null : question non passée). */
  parExperiment: Record<string, { statut: number | null; fidelite: number | null } | null>;
}

/**
 * Questions sur lesquelles les experiments ne s'accordent pas (bon statut ou
 * fidélité différents de la référence) : c'est là qu'il faut lire les réponses.
 */
export async function ecartsEntreExperiments(
  mastra: Mastra,
  dataset: Dataset,
  experimentIds: string[],
  baselineId = experimentIds[0],
): Promise<Ecart[]> {
  const cmp = await mastra.datasets.compareExperiments({ experimentIds, baselineId });
  const qids = new Map((await allItems(dataset)).map((i) => [i.id, (i.metadata as ItemMetadata | undefined)?.qid]));
  const ecarts: Ecart[] = [];
  for (const item of cmp.items) {
    const parExperiment: Ecart["parExperiment"] = {};
    for (const [expId, r] of Object.entries(item.results)) {
      parExperiment[expId] = r
        ? { statut: r.scores[statutScorer.id] ?? null, fidelite: r.scores[fideliteScorer.id] ?? null }
        : null;
    }
    const ref = parExperiment[cmp.baselineId];
    const differe = Object.values(parExperiment).some(
      (v) => !v || !ref || v.statut !== ref.statut || Math.abs((v.fidelite ?? 1) - (ref.fidelite ?? 1)) >= 0.1,
    );
    if (differe) {
      ecarts.push({
        qid: qids.get(item.itemId) ?? item.itemId,
        question: (item.input as { question?: string } | null)?.question ?? "",
        parExperiment,
      });
    }
  }
  return ecarts;
}
