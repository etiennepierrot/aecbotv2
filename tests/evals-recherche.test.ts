import { describe, expect, it } from "vitest";
import { evaluerRecherche } from "../src/aec/evals-recherche.js";
import type { EvalQuestion } from "../src/aec/evals.js";
import { correspondA } from "../src/aec/sources-attendues.js";
import type { RetrievedPassage } from "../src/aec/types.js";

const passage = (title: string, page: number | null, score: number): RetrievedPassage => ({
  id: `${title}#${page}`, score, docId: title, title, url: `u/${title}`, page, section: null,
  category: "livret", corpus: "aec2027", provisional: false, text: "…",
});

describe("correspondA", () => {
  it("compare les titres sans casse ni ponctuation, et les pages si elles sont données", () => {
    expect(correspondA("Livret_EMPLOI-2025", [18], { document: "emploi", pages: [18, 23] })).toBe(true);
    expect(correspondA("Livret_EMPLOI-2025", [19], { document: "emploi", pages: [18, 23] })).toBe(false);
    expect(correspondA("Livret_EMPLOI-2025", [null], { document: "emploi" })).toBe(true);
    expect(correspondA("Livret ENERGIES", [18], { document: "emploi" })).toBe(false);
  });
});

describe("evaluerRecherche", () => {
  const questions: EvalQuestion[] = [
    { id: "premier", question: "q1", attendu: "repondu", sources: [{ document: "EMPLOI", pages: [18] }] },
    { id: "troisieme", question: "q2", attendu: "repondu", sources: [{ document: "EMPLOI", pages: [18] }, { document: "ABSENT" }] },
    { id: "rate", question: "q3", attendu: "repondu", sources: [{ document: "ABSENT" }] },
    { id: "hors", question: "q4", attendu: "introuvable" },
    { id: "panne", question: "q5", attendu: "repondu", sources: [{ document: "EMPLOI" }] },
  ];
  const resultats: Record<string, RetrievedPassage[]> = {
    q1: [passage("EMPLOI", 18, 0.9), passage("ENERGIES", 4, 0.8)],
    q2: [passage("ENERGIES", 4, 0.85), passage("EMPLOI", 19, 0.84), passage("EMPLOI", 18, 0.83)],
    q3: [passage("ENERGIES", 4, 0.7)],
    q4: [passage("ENERGIES", 4, 0.6)],
  };
  const recherche = async (q: string) => {
    if (q === "q5") throw new Error("base injoignable");
    return resultats[q]!;
  };

  it("donne le rang de la première source attendue, la couverture et les métriques", async () => {
    const r = await evaluerRecherche(questions, recherche, { topK: 10 });
    const par = Object.fromEntries(r.questions.map((q) => [q.id, q]));

    expect(par.premier).toMatchObject({ rang: 1, couverture: 1, scorePertinent: 0.9, scoreMax: 0.9 });
    expect(par.troisieme).toMatchObject({ rang: 3, couverture: 0.5, scorePertinent: 0.83 });
    expect(par.rate).toMatchObject({ rang: null, couverture: 0 });
    expect(par.hors).toMatchObject({ rang: null, couverture: null, scoreMax: 0.6 });
    // Une panne compte comme un échec, pas comme une question écartée.
    expect(par.panne).toMatchObject({ rang: null, couverture: 0, erreur: "base injoignable" });

    expect(r.evaluees).toBe(4);
    expect(r.recall).toEqual({ 1: 0.25, 3: 0.5, 5: 0.5, 10: 0.5 });
    expect(r.mrr).toBeCloseTo((1 + 1 / 3) / 4);
    expect(r.couvertureMoyenne).toBeCloseTo((1 + 0.5) / 4);
    expect(r.scoresMax).toEqual({ repondu: [0.9, 0.85, 0.7], introuvable: [0.6] });
    expect(par.troisieme!.top.map((t) => t.pertinent)).toEqual([false, false, true]);
  });
});
