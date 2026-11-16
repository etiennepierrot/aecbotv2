import { repondre, type RepondreResult } from "./repondre.js";
import type { Attendu } from "../mastra/scorers/index.js";
import { citationsScorer, fideliteScorer, sourceAttendueScorer, statutScorer } from "../mastra/scorers/index.js";

export interface EvalQuestion extends Attendu {
  id: string;
  question: string;
  note?: string;
}

export interface Prix {
  entree: number | null;
  sortie: number | null;
}

export interface QuestionResult {
  id: string;
  question: string;
  attendu: Attendu["attendu"];
  statut?: "repondu" | "introuvable";
  texte?: string;
  scores: { citations?: number; statut?: number; sourceAttendue?: number; fidelite?: number };
  fideliteRaison?: string;
  citationsRejetees: number;
  inputTokens: number;
  outputTokens: number;
  erreur?: string;
}

export interface EvalReport {
  model: string;
  questions: QuestionResult[];
  grille: {
    citationsRejetees: number;
    horsCorpusIntrouvable: number | null;
    fideliteMoyenne: number | null;
    statutCorrect: number;
    sourceAttendue: number;
    coutParQuestionUsd: number | null;
    jetonsMoyens: { entree: number; sortie: number };
    erreurs: number;
  };
  passe: boolean;
}

/** Les seuils décidés pour choisir le modèle. */
export const SEUILS = { citationsRejetees: 0, horsCorpusIntrouvable: 1, fidelite: 0.9 } as const;

export async function runEvalSuite(args: {
  questions: EvalQuestion[];
  model: string;
  prix?: Prix;
  juge?: boolean;
  repondreImpl?: typeof repondre;
  onProgress?: (r: QuestionResult) => void;
}): Promise<EvalReport> {
  const answer = args.repondreImpl ?? repondre;
  const results: QuestionResult[] = [];

  for (const q of args.questions) {
    const groundTruth: Attendu = { attendu: q.attendu, sources: q.sources };
    let res: RepondreResult;
    try {
      res = await answer(q.question, { model: args.model });
    } catch (e) {
      const r: QuestionResult = {
        id: q.id, question: q.question, attendu: q.attendu, scores: {},
        citationsRejetees: 0, inputTokens: 0, outputTokens: 0,
        erreur: e instanceof Error ? e.message : String(e),
      };
      results.push(r);
      args.onProgress?.(r);
      continue;
    }

    const run = { input: { question: q.question }, output: { reponse: res.reponse, passages: res.passages }, groundTruth };
    const [citations, statut, source] = await Promise.all([
      citationsScorer.run(run),
      statutScorer.run(run),
      sourceAttendueScorer.run(run),
    ]);
    const fidelite = args.juge && res.reponse.statut === "repondu" ? await fideliteScorer.run(run) : undefined;

    const r: QuestionResult = {
      id: q.id,
      question: q.question,
      attendu: q.attendu,
      statut: res.reponse.statut,
      texte: res.reponse.texte,
      scores: {
        citations: citations.score,
        statut: statut.score,
        sourceAttendue: q.attendu === "repondu" ? source.score : undefined,
        fidelite: fidelite?.score,
      },
      fideliteRaison: fidelite?.reason || undefined,
      citationsRejetees: res.reponse.controle.citationsRejetees,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
    };
    results.push(r);
    args.onProgress?.(r);
  }

  return summarize(args.model, results, args.prix);
}

export function summarize(model: string, results: QuestionResult[], prix?: Prix): EvalReport {
  const ok = results.filter((r) => !r.erreur);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  const hors = ok.filter((r) => r.attendu === "introuvable");
  const fid = ok.map((r) => r.scores.fidelite).filter((x): x is number => x !== undefined);
  const src = ok.map((r) => r.scores.sourceAttendue).filter((x): x is number => x !== undefined);
  const inTok = mean(ok.map((r) => r.inputTokens)) ?? 0;
  const outTok = mean(ok.map((r) => r.outputTokens)) ?? 0;
  const cout =
    prix?.entree != null && prix?.sortie != null ? (inTok * prix.entree + outTok * prix.sortie) / 1_000_000 : null;

  const grille = {
    citationsRejetees: ok.reduce((n, r) => n + r.citationsRejetees, 0),
    // null : aucune question hors corpus n'a abouti (toutes en erreur, ou --only sans elles).
    horsCorpusIntrouvable: hors.length ? hors.filter((r) => r.statut === "introuvable").length / hors.length : null,
    fideliteMoyenne: mean(fid),
    statutCorrect: mean(ok.map((r) => r.scores.statut ?? 0)) ?? 0,
    sourceAttendue: mean(src) ?? 0,
    coutParQuestionUsd: cout,
    jetonsMoyens: { entree: Math.round(inTok), sortie: Math.round(outTok) },
    erreurs: results.length - ok.length,
  };
  const passe =
    grille.erreurs === 0 &&
    grille.citationsRejetees <= SEUILS.citationsRejetees &&
    (grille.horsCorpusIntrouvable ?? 1) >= SEUILS.horsCorpusIntrouvable &&
    (grille.fideliteMoyenne === null || grille.fideliteMoyenne >= SEUILS.fidelite);

  return { model, questions: results, grille, passe };
}
