/**
 * L'agent de bout en bout avec un modèle simulé et une recherche simulée :
 * on vérifie le câblage outil → collecteur → vérification, sans réseau ni base.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { RetrievedPassage } from "../src/aec/types.js";
import type { EvalQuestion } from "../src/aec/evals.js";
import { fakeModel, lastToolOutput } from "./helpers/fake-model.js";

const PASSAGES: Record<string, RetrievedPassage[]> = {
  retraite: [
    {
      id: "wp:media:15699#p33#0", score: 0.91, docId: "wp:media:15699", title: "PROGRAMME SITE 2025",
      url: "https://melenchon2027.fr/wp-content/uploads/2025/02/A5-PROGRAMME-SITE.pdf", page: 33, section: null,
      category: "programme", corpus: "aec2027", provisional: true,
      text: "Rétablir la retraite à 60 ans après quarante années de cotisation",
    },
  ],
};

const queries: { query: unknown; filter: unknown }[] = [];

let repondre: typeof import("../src/aec/repondre.js").repondre;
let runEvalSuite: typeof import("../src/aec/evals.js").runEvalSuite;

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgresql://inutilise@localhost/inutilise";
  const deps = await import("../src/corpus/deps.js");
  deps.setRetrievalDeps({
    embedder: { dimension: 3, embed: async (t: string[]) => t.map(() => [1, 0, 0]) },
    vector: {
      query: (async (args: { queryVector: unknown; filter: unknown }) => {
        queries.push({ query: args.queryVector, filter: args.filter });
        const corpus = (args.filter as { corpus: { $eq?: string } }).corpus.$eq;
        return corpus === "aec2027" ? PASSAGES.retraite!.map((p) => ({ id: p.id, score: p.score, metadata: { ...p } })) : [];
      }) as never,
    },
  });
  ({ repondre } = await import("../src/aec/repondre.js"));
  ({ runEvalSuite } = await import("../src/aec/evals.js"));
});

describe("repondre", () => {
  it("cherche, reçoit des passages numérotés, et ne garde que les citations réelles", async () => {
    const model = fakeModel((prompt, call) => {
      if (call === 1) return { tool: "recherche", input: { requete: "retraite âge légal" } };
      const seen = lastToolOutput(prompt) ?? "";
      expect(seen).toContain("[P1] PROGRAMME SITE 2025 — page 33 (programme général)");
      expect(seen).not.toContain("https://"); // le modèle ne voit pas les URL
      return { text: "Le programme prévoit de rétablir la retraite à 60 ans [P1]. Il supprime aussi la CSG [P4]." };
    });

    const res = await repondre("Qu'est-ce que le programme dit sur la retraite ?", { model });
    expect(res.reponse).toMatchObject({
      statut: "repondu",
      texte: "Le programme prévoit de rétablir la retraite à 60 ans [1].",
      sources: [{ n: 1, pages: [33], title: "PROGRAMME SITE 2025" }],
      controle: { passagesRecuperes: 1, citationsValides: 1, citationsRejetees: 1, phrasesRetirees: 1 },
    });
    expect(res.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
    // La première étape impose l'appel de l'outil ; la suivante laisse le modèle libre.
    expect(model.calls[0]!.toolChoice).toEqual({ type: "required" });
    expect(model.calls[1]!.toolChoice).not.toEqual({ type: "required" });
    // Par défaut : une requête par édition de EDITIONS (2027 puis 2022), chacune avec son quota.
    expect(queries.slice(-2).map((q) => q.filter)).toEqual([{ corpus: { $eq: "aec2027" } }, { corpus: { $eq: "aec2022" } }]);
  });

  describe("réponse partielle : contrôle de l'objet de la question", () => {
    const partielle = (suite: string) =>
      fakeModel((_p, call) =>
        call === 1
          ? { tool: "recherche", input: { requete: "retraite" } }
          : { text: `Je ne trouve pas de passage qui réponde précisément à cette question.\n\n${suite} [P1].` },
      );

    it("devient introuvable quand les passages cités ne traitent que d'un thème voisin", async () => {
      const vus: { question: string; refs: string[] }[] = [];
      const res = await repondre("Le programme veut-il supprimer le changement d'heure ?", {
        model: partielle("Le programme prévoit la retraite à 60 ans"),
        controleObjet: async (question, passages) => {
          vus.push({ question, refs: passages.map((p) => p.ref) });
          return { objet: "le changement d'heure", traite: false, raison: "le passage parle de la retraite" };
        },
      });
      expect(vus).toEqual([{ question: "Le programme veut-il supprimer le changement d'heure ?", refs: ["P1"] }]);
      expect(res.reponse).toMatchObject({ statut: "introuvable", sources: [], controle: { objet: { verdict: "non", objet: "le changement d'heure" } } });
    });

    it("reste répondue quand un passage traite de l'objet précis", async () => {
      const res = await repondre("Partira-t-on à 60 ans pour toutes les carrières ?", {
        model: partielle("Le programme prévoit la retraite à 60 ans après quarante annuités"),
        controleObjet: async () => ({ objet: "l'âge de départ à la retraite", traite: true, raison: "même mesure" }),
      });
      expect(res.reponse).toMatchObject({ statut: "repondu", controle: { objet: { verdict: "oui" } } });
    });

    it("garde la réponse si le contrôle tombe en panne", async () => {
      const res = await repondre("Partira-t-on à 60 ans ?", {
        model: partielle("Le programme prévoit la retraite à 60 ans"),
        controleObjet: async () => {
          throw new Error("429");
        },
      });
      expect(res.reponse).toMatchObject({ statut: "repondu", controle: { objet: { verdict: "erreur", raison: "429" } } });
    });

    it("n'appelle pas le contrôle pour une réponse directe", async () => {
      let appels = 0;
      const model = fakeModel((_p, call) =>
        call === 1 ? { tool: "recherche", input: { requete: "retraite" } } : { text: "Retraite à 60 ans [P1].\n\n---" },
      );
      const res = await repondre("Et la retraite ?", { model, controleObjet: async () => (appels++, { objet: "", traite: false, raison: "" }) });
      expect(appels).toBe(0);
      expect(res.reponse).toMatchObject({ statut: "repondu", texte: "Retraite à 60 ans [1]." }); // séparateur « --- » retiré
      expect(res.reponse.controle.objet).toBeUndefined();
    });
  });

  it("ne garde que les suites que le corpus sait servir", async () => {
    const model = fakeModel((_prompt, call) =>
      call === 1
        ? { tool: "recherche", input: { requete: "retraite" } }
        : { text: "Retraite à 60 ans [P1].\nSUITES :\n1. Comment serait-elle financée ? [P1]\n2. Et le football ? [P1]" },
    );
    // La recherche simulée ne trouve rien pour un filtre multi-éditions : score 0, suites écartées.
    const res = await repondre("Et la retraite ?", { model });
    expect(res.reponse.texte).toBe("Retraite à 60 ans [1].");
    expect(res.reponse.suites).toEqual([]);
    expect(res.reponse.controle.suitesRetirees).toBe(2);
    // Avant le filtre par score, les deux suites citaient un passage reçu.
    expect(res.suitesAvantFiltre).toEqual(["Comment serait-elle financée ?", "Et le football ?"]);
  });

  it("une panne de la recherche remonte comme une erreur, pas comme « introuvable »", async () => {
    const deps = await import("../src/corpus/deps.js");
    const previous = await deps.retrievalDeps();
    deps.setRetrievalDeps({
      embedder: { dimension: 3, embed: async () => { throw new Error("password authentication failed for user 'neondb_owner'"); } },
      vector: previous.vector,
    });
    const model = fakeModel((prompt, call) => {
      if (call === 1) return { tool: "recherche", input: { requete: "SMIC" } };
      // Le modèle est prié de ne pas réessayer en boucle.
      expect(lastToolOutput(prompt)).toContain("Ne réessaie pas");
      return { text: "INTROUVABLE" };
    });
    await expect(repondre("Et le SMIC ?", { model })).rejects.toThrow(/Recherche impossible : password authentication failed/);
    expect(model.calls).toHaveLength(2);
    deps.setRetrievalDeps(previous);
  });

  it("une réponse « de mémoire », sans recherche, est refusée", async () => {
    const model = fakeModel(() => ({ text: "La retraite sera à 60 ans [P1]." }));
    const res = await repondre("Et la retraite ?", { model });
    expect(res.reponse.statut).toBe("introuvable");
    expect(res.reponse.controle.citationsRejetees).toBe(1);
  });

  it("une édition nommée filtre la recherche et ne retombe pas sur une autre", async () => {
    const model = fakeModel((prompt, call) => {
      if (call === 1) return { tool: "recherche", input: { requete: "retraite", edition: "aec2022" } };
      expect(lastToolOutput(prompt)).toBe("Aucun passage trouvé pour cette requête.");
      return { text: "INTROUVABLE" };
    });
    const res = await repondre("Que disait l'édition 2022 sur la retraite ?", { model });
    expect(res.reponse.statut).toBe("introuvable");
    expect(queries.at(-1)?.filter).toEqual({ corpus: { $eq: "aec2022" } });
  });

  it("transmet l'historique pour les questions de suite", async () => {
    const model = fakeModel((prompt) => {
      expect(prompt.filter((m: { role: string }) => m.role === "user")).toHaveLength(2);
      return { text: "INTROUVABLE" };
    });
    await repondre("Et pour les femmes ?", {
      model,
      historique: [
        { role: "user", content: "Et la retraite ?" },
        { role: "assistant", content: "Retraite à 60 ans [1]." },
      ],
    });
    expect(model.calls).toHaveLength(1);
  });
});

describe("runEvalSuite (sans juge)", () => {
  it("applique la grille de décision", async () => {
    const questions: EvalQuestion[] = [
      { id: "retraite", question: "Retraite ?", attendu: "repondu", sources: [{ document: "PROGRAMME SITE 2025", pages: [33] }] },
      { id: "heure", question: "Changement d'heure ?", attendu: "introuvable" },
    ];
    const model = fakeModel((prompt, call) => {
      const q = JSON.stringify(prompt.filter((m: { role: string }) => m.role === "user").at(-1));
      if (q.includes("Retraite")) {
        return call % 2 === 1 ? { tool: "recherche", input: { requete: "retraite" } } : { text: "Retraite à 60 ans [P1]." };
      }
      return { text: "Le programme supprime le changement d'heure [P2]." }; // invention
    });
    let call = 0;
    const report = await runEvalSuite({
      questions,
      model: "fake",
      prix: { entree: 1, sortie: 10 },
      repondreImpl: (q, o) => repondre(q, { ...o, model: (call++, model) }),
    });
    expect(report.questions.map((q) => [q.id, q.statut, q.scores.statut, q.scores.sourceAttendue])).toEqual([
      ["retraite", "repondu", 1, 1],
      ["heure", "introuvable", 1, undefined],
    ]);
    // L'invention a été rattrapée par la vérification, mais elle compte comme citation rejetée : le modèle échoue.
    expect(report.grille).toMatchObject({ citationsRejetees: 1, horsCorpusIntrouvable: 1, statutCorrect: 1, sourceAttendue: 1 });
    expect(report.passe).toBe(false);
    expect(report.grille.coutParQuestionUsd).toBeCloseTo((150 * 1 + 30 * 10) / 1e6);
  });
});
