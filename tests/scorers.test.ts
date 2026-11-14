import { describe, expect, it } from "vitest";
import { createFideliteScorer, sourceAttendueScorer } from "../src/mastra/scorers/index.js";
import type { Answer } from "../src/aec/types.js";
import { fakeModel } from "./helpers/fake-model.js";

const reponse: Answer = {
  statut: "repondu",
  texte: "Le programme prévoit la retraite à 60 ans [1]. Il prévoit aussi la semaine de 4 jours [1].",
  sources: [{ n: 1, title: "PROGRAMME SITE 2025", url: "u", page: 33, category: "programme", corpus: "aec2027", provisional: true }],
  avertissements: [],
  controle: { passagesRecuperes: 1, citationsValides: 2, citationsRejetees: 0, phrasesRetirees: 0, phrasesSansSource: 0 },
};
const passages = [{
  ref: "P1", id: "x", score: 1, docId: "d", title: "PROGRAMME SITE 2025", url: "u", page: 33,
  category: "programme" as const, corpus: "aec2027" as const, provisional: true,
  text: "Rétablir la retraite à 60 ans après quarante années de cotisation",
}];

describe("scorers", () => {
  it("fidélité : le juge voit les passages cités et le score compte les affirmations soutenues", async () => {
    let prompt = "";
    const judge = fakeModel((p) => {
      prompt = JSON.stringify(p);
      return {
        text: JSON.stringify({
          affirmations: [
            { phrase: "retraite à 60 ans", soutenue: true, raison: "page 33" },
            { phrase: "semaine de 4 jours", soutenue: false, raison: "absent du passage" },
          ],
        }),
      };
    });
    const res = await createFideliteScorer(judge).run({
      input: { question: "Retraite ?" },
      output: { reponse, passages },
    });
    expect(prompt).toContain("Rétablir la retraite à 60 ans");
    expect(res.score).toBe(0.5);
    expect(res.reason).toContain("semaine de 4 jours");
  });

  it("source attendue : compare titre (sans ponctuation) et page", async () => {
    const run = (sources: { document: string; pages?: number[] }[]) =>
      sourceAttendueScorer.run({ input: { question: "q" }, output: { reponse, passages }, groundTruth: { attendu: "repondu", sources } });
    expect((await run([{ document: "programme site 2025", pages: [33] }])).score).toBe(1);
    expect((await run([{ document: "PROGRAMME SITE 2025", pages: [34] }])).score).toBe(0);
    expect((await run([{ document: "EMPLOI" }])).score).toBe(0);
  });
});
