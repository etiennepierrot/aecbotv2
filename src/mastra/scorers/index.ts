import { createScorer, notScorable } from "@mastra/core/evals";
import { z } from "zod";
import type { Answer, ReferencedPassage } from "../../aec/types.js";
import { defaultModels } from "../../config.js";
import { correspondA, type SourceAttendue } from "../../aec/sources-attendues.js";

/** Ce que les scorers évaluent : une réponse vérifiée et les passages vus par l'agent. */
export interface ScoredRun {
  reponse: Answer;
  passages: ReferencedPassage[];
}

export interface Attendu {
  attendu: "repondu" | "introuvable";
  /** Au moins une de ces sources devrait être citée (titre contenant `document`, page parmi `pages`). */
  sources?: SourceAttendue[];
}

/** Part des citations du modèle qui renvoient à un passage réellement récupéré. Seuil : 1. */
export const citationsScorer = createScorer<{ question: string }, ScoredRun>({
  id: "citations-valides",
  description: "Part des citations qui correspondent à un passage récupéré (1 = aucune citation rejetée).",
}).generateScore(({ run }) => {
  const { citationsValides: ok, citationsRejetees: ko } = run.output.reponse.controle;
  return ok + ko === 0 ? 1 : ok / (ok + ko);
});

/** La réponse a-t-elle le bon statut (répondre, ou dire qu'on ne sait pas) ? */
export const statutScorer = createScorer<{ question: string }, ScoredRun>({
  id: "statut-attendu",
  description: "1 si l'agent répond quand le corpus contient la réponse et dit « introuvable » sinon.",
}).generateScore(({ run }) => (run.output.reponse.statut === (run.groundTruth as Attendu).attendu ? 1 : 0));

/** Une des sources attendues est-elle citée ? Indicatif : plusieurs documents disent parfois la même chose. */
export const sourceAttendueScorer = createScorer<{ question: string }, ScoredRun>({
  id: "source-attendue",
  description: "1 si au moins une source attendue (document et page) est citée.",
})
  // Question hors corpus : pas de source attendue, la compter à 1 gonflerait la moyenne.
  .preprocess(({ run }) => ((run.groundTruth as Attendu | undefined)?.attendu === "introuvable" ? notScorable("question hors corpus") : {}))
  .generateScore(({ run }) => {
  const expected = (run.groundTruth as Attendu).sources ?? [];
  if (expected.length === 0) return 1;
  return run.output.reponse.sources.some((s) => expected.some((e) => correspondA(s.title, s.pages, e)))
    ? 1
    : 0;
});

/** Le juge : un modèle plus fort que celui qui répond, idéalement. */
export const DEFAULT_JUDGE_MODEL = process.env.AEC_JUDGE_MODEL?.trim() || defaultModels().judge;

/**
 * Fidélité aux sources (juge LLM) : chaque phrase de la réponse est-elle
 * soutenue par les passages qu'elle cite ? Seuil : 0,9.
 */
export const createFideliteScorer = (judgeModel: string | object = DEFAULT_JUDGE_MODEL) =>
  createScorer<{ question: string }, ScoredRun>({
  id: "fidelite",
  description: "Part des affirmations de la réponse soutenues par les passages cités.",
  judge: {
    model: judgeModel as never,
    instructions:
      "Tu vérifies des réponses sourcées. Tu es strict : une affirmation n'est soutenue que si le passage " +
      "cité dit la même chose, sans ajout ni extrapolation. Tu réponds en JSON.",
  },
})
  // Rien à vérifier (et pas d'appel au juge) quand l'agent répond « introuvable ».
  .preprocess(({ run }) => (run.output.reponse.statut === "introuvable" ? notScorable("réponse « introuvable »") : {}))
  .analyze({
    description: "Vérifie chaque affirmation contre les passages",
    outputSchema: z.object({
      affirmations: z.array(z.object({ phrase: z.string(), soutenue: z.boolean(), raison: z.string() })),
    }),
    createPrompt: ({ run }) => {
      const { reponse, passages } = run.output;
      const citedSource = (p: ReferencedPassage) =>
        reponse.sources.find((s) => s.url === p.url && (p.page === null || s.pages.includes(p.page)));
      const context = passages
        .filter((p) => citedSource(p))
        .map((p) => {
          const n = citedSource(p)?.n;
          return `[${n}] ${p.title}, page ${p.page ?? "web"}\n${p.text}`;
        })
        .join("\n\n");
      return `Question : ${run.input?.question ?? ""}

Réponse à vérifier (les appels [n] renvoient aux passages) :
${reponse.texte}

Passages cités :
${context}

Découpe la réponse en affirmations factuelles. Pour chacune, indique si les passages cités la soutiennent.
Une phrase purement introductive (« Le programme prévoit plusieurs mesures : ») n'est pas une affirmation.`;
    },
  })
  .generateScore(({ run, results }) => {
    if (run.output.reponse.statut === "introuvable") return 1;
    const a = results.analyzeStepResult.affirmations;
    return a.length === 0 ? 1 : a.filter((x) => x.soutenue).length / a.length;
  })
  .generateReason(({ results }) =>
    results.analyzeStepResult.affirmations
      .filter((x) => !x.soutenue)
      .map((x) => `Non soutenue : « ${x.phrase} » (${x.raison})`)
      .join("\n"),
  );

export const fideliteScorer = createFideliteScorer();

export const scorers = {
  citations: citationsScorer,
  statut: statutScorer,
  sourceAttendue: sourceAttendueScorer,
  fidelite: fideliteScorer,
};
