/**
 * Dataset et experiments Mastra, en mémoire et avec un `repondre` simulé :
 * synchronisation du dataset depuis le JSON, passe d'évals, grille, comparaison.
 */
import { describe, expect, it } from "vitest";
import { Mastra } from "@mastra/core";
import { InMemoryStore } from "@mastra/core/storage";
import type { EvalQuestion } from "../src/aec/evals.js";
import type { RepondreResult } from "../src/aec/repondre.js";
import type { Answer } from "../src/aec/types.js";
import { ecartsEntreExperiments, runModelExperiment, syncQuestionsDataset } from "../src/aec/experiments.js";
import { scorers } from "../src/mastra/scorers/index.js";

const QUESTIONS: EvalQuestion[] = [
  { id: "retraite", question: "Retraite ?", attendu: "repondu", sources: [{ document: "PROGRAMME SITE 2025", pages: [33] }] },
  { id: "meteo", question: "Quel temps demain ?", attendu: "introuvable" },
];

const answer = (statut: Answer["statut"], citationsRejetees = 0): RepondreResult => ({
  reponse: {
    statut,
    texte: statut === "repondu" ? "Retraite à 60 ans [1]." : "INTROUVABLE",
    sources: statut === "repondu"
      ? [{ n: 1, title: "PROGRAMME SITE 2025", url: "u", pages: [33], category: "programme", corpus: "aec2027", provisional: true }]
      : [],
    avertissements: [],
    controle: { passagesRecuperes: 1, citationsValides: statut === "repondu" ? 1 : 0, citationsRejetees, phrasesRetirees: 0, phrasesSansSource: 0 },
  },
  brut: "",
  suitesAvantFiltre: [],
  passages: [],
  usage: { inputTokens: 100, outputTokens: 20 },
});

const newMastra = () => new Mastra({ storage: new InMemoryStore(), scorers, logger: false });

describe("experiments", () => {
  it("synchronise le dataset avec le fichier : ajoute, met à jour, retire", async () => {
    const mastra = newMastra();
    const first = await syncQuestionsDataset(mastra, QUESTIONS, { id: "test" });
    expect(first).toMatchObject({ ajoutees: 2, modifiees: 0, retirees: 0 });

    const again = await syncQuestionsDataset(mastra, QUESTIONS, { id: "test" });
    expect(again).toMatchObject({ ajoutees: 0, modifiees: 0, retirees: 0 });

    const edited = [{ ...QUESTIONS[0]!, question: "Âge de la retraite ?" }, { id: "smic", question: "SMIC ?", attendu: "repondu" as const }];
    const third = await syncQuestionsDataset(mastra, edited, { id: "test" });
    expect(third).toMatchObject({ ajoutees: 1, modifiees: 1, retirees: 1 });
  });

  it("passe d'évals en experiment : scores, grille, et écarts entre deux modèles", async () => {
    const mastra = newMastra();
    const { dataset } = await syncQuestionsDataset(mastra, QUESTIONS, { id: "test" });

    const progress: string[] = [];
    const bon = await runModelExperiment({
      dataset, model: "bon", prix: { entree: 1, sortie: 2 },
      repondreImpl: async (q) => answer(q.startsWith("Retraite") ? "repondu" : "introuvable"),
      onProgress: (r) => progress.push(r.id),
    });
    expect(progress.sort()).toEqual(["meteo", "retraite"]);
    expect(bon.report.passe).toBe(true);
    expect(bon.report.grille).toMatchObject({ statutCorrect: 1, sourceAttendue: 1, horsCorpusIntrouvable: 1, citationsRejetees: 0 });
    // Question hors corpus : pas de score de source attendue (notScorable), seulement la question « retraite ».
    expect(bon.report.questions.find((q) => q.id === "meteo")!.scores.sourceAttendue).toBeUndefined();
    expect(bon.report.grille.coutParQuestionUsd).toBeCloseTo((100 * 1 + 20 * 2) / 1_000_000);

    // Le second modèle répond à tout, avec une citation inventée.
    const bavard = await runModelExperiment({ dataset, model: "bavard", repondreImpl: async () => answer("repondu", 1) });
    expect(bavard.report.passe).toBe(false);
    expect(bavard.report.grille.horsCorpusIntrouvable).toBe(0);

    // Experiments enregistrés, et seule la question « meteo » diffère.
    const { experiments } = await dataset.listExperiments();
    expect(experiments).toHaveLength(2);
    const ecarts = await ecartsEntreExperiments(mastra, dataset, [bon.experimentId, bavard.experimentId]);
    expect(ecarts.map((e) => e.qid)).toEqual(["meteo"]);
    expect(ecarts[0]!.parExperiment[bavard.experimentId]).toMatchObject({ statut: 0 });
  });

  it("une erreur de la tâche devient une question en erreur, pas un plantage", async () => {
    const mastra = newMastra();
    const { dataset } = await syncQuestionsDataset(mastra, QUESTIONS, { id: "test" });
    const { report } = await runModelExperiment({
      dataset, model: "panne",
      repondreImpl: async () => { throw new Error("Recherche impossible : base injoignable"); },
    });
    expect(report.grille.erreurs).toBe(2);
    expect(report.questions[0]!.erreur).toContain("Recherche impossible");
    expect(report.passe).toBe(false);
  });
});
