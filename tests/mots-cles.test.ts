import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { motsClesHandler } from "../src/mastra/routes/mots-cles.js";
import { mots, motsCles, nuageHtml } from "../src/telegram/mots-cles.js";

const q = (pseudo: string, content: string) => ({ pseudo, content });

describe("mots", () => {
  it("retire mots vides, élisions et mots courts", () => {
    expect(mots("Que propose le programme sur l'école et la retraite à 60 ans ?")).toEqual(["école", "retraite", "ans"]);
  });
});

describe("motsCles", () => {
  const questions = [
    q("u_a", "Que dit le programme sur les retraites ?"),
    q("u_b", "Et la retraite à 60 ans, retraite pleine ?"),
    q("u_c", "Quel SMIC ? Et la Retraite ?"),
    q("u_a", "Le SMIC à 1600 euros ?"),
    q("u_b", "Et le smic net ?"),
    q("u_a", "Parle-moi de Trifouilly-les-Oies"),
  ];

  it("compte une fois par question, regroupe casse, accents et pluriel", () => {
    const r = motsCles(questions);
    expect(r[0]).toEqual({ mot: "retraite", questions: 3, personnes: 3, poids: 1 });
    expect(r.find((m) => m.mot.toLowerCase() === "smic")).toMatchObject({ questions: 3, personnes: 3 });
  });

  it("écarte un mot employé par une seule personne", () => {
    const r = motsCles(questions);
    expect(r.map((m) => m.mot)).not.toContain("trifouilly-les-oies");
    expect(r.map((m) => m.mot)).not.toContain("euros");
  });

  it("respecte la limite et normalise le poids", () => {
    const r = motsCles(questions, { limite: 1 });
    expect(r).toHaveLength(1);
    expect(motsCles([])).toEqual([]);
  });
});

describe("nuageHtml", () => {
  it("échappe les mots", () => {
    const html = nuageHtml([{ mot: "<b>", questions: 2, personnes: 2, poids: 1 }], { jours: 30 });
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<li class=\"t4\" style=\"font-size:3.50rem\" title=\"2 question(s), 2 personne(s)\"><b>");
  });
});

describe("motsCles sur la copie anonymisée", () => {
  it("filtre au nombre de questions, sans compter les personnes", () => {
    const r = motsCles(
      ["retraite ?", "la retraite", "retraites", "smic", "smic"].map((content) => ({ content })),
      { minQuestions: 3 },
    );
    expect(r).toEqual([{ mot: "retraite", questions: 3, poids: 1 }]);
  });
});

describe("GET /stats/mots-cles", () => {
  function app(
    questions = [q("u_a", "retraite"), q("u_b", "retraite"), q("u_c", "smic")],
    anonymes = ["smic", "smic", "smic", "retraite"],
  ) {
    const appels: string[] = [];
    const store = {
      questionsRecentes: async (j: number) => (appels.push(`memoire:${j}`), questions),
      questionsAnonymes: async (j: number) => (appels.push(`anonymes:${j}`), anonymes),
    };
    const h = new Hono().get("/stats/mots-cles", motsClesHandler(() => ({ store, memoryDays: 30 })));
    return { h, appels };
  }

  it("jusqu'à MEMORY_DAYS : mémoire du bot, min_personnes jamais sous 2", async () => {
    const { h, appels } = app();
    const res = await h.request("/stats/mots-cles?min_personnes=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mots: unknown };
    expect(appels).toEqual(["memoire:30"]);
    expect(body).toMatchObject({ jours: 30, questions: 3, source: "memoire", minPersonnes: 2 });
    expect(body.mots).toEqual([{ mot: "retraite", questions: 2, personnes: 2, poids: 1 }]);
  });

  it("au-delà : copie anonymisée, min_questions jamais sous 3, jours bornés", async () => {
    const { h, appels } = app();
    const body = (await (await h.request("/stats/mots-cles?jours=99999&min_questions=1")).json()) as { mots: unknown };
    expect(appels).toEqual(["anonymes:3650"]);
    expect(body).toMatchObject({ jours: 3650, questions: 4, source: "anonymes", minQuestions: 3 });
    expect(body.mots).toEqual([{ mot: "smic", questions: 3, poids: 1 }]);
  });

  it("renvoie une page HTML avec format=html", async () => {
    const { h } = app();
    const res = await h.request("/stats/mots-cles?format=html&jours=7");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain(">retraite</li>");
  });
});
