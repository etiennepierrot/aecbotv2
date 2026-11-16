import { describe, expect, it } from "vitest";
import { fuse } from "../src/aec/search.js";
import type { RetrievedPassage } from "../src/aec/types.js";
import { termesRecherche } from "../src/corpus/fulltext.js";

describe("termesRecherche", () => {
  it("garde les mots qui distinguent, sans mots vides ni mots du domaine", () => {
    expect(termesRecherche("Que prévoit le programme sur la corrida ?")).toEqual(["corrida"]);
    expect(termesRecherche("Le programme veut-il quitter l'OTAN ?")).toEqual(["quitter", "otan"]);
    // « les » : Postgres le garde (« le »), et il correspondrait à tous les passages.
    expect(termesRecherche("Va-t-on bloquer les prix de l'énergie ?")).toEqual(["bloquer", "prix", "énergie"]);
    expect(termesRecherche("Les cantines scolaires seront-elles gratuites ?")).toEqual(["cantines", "scolaires", "gratuites"]);
    expect(termesRecherche("Que propose Mélenchon ?")).toEqual([]);
    expect(termesRecherche("?!")).toEqual([]);
  });
});

describe("fuse", () => {
  const p = (id: string, score: number): RetrievedPassage => ({
    id, score, docId: id, title: id, url: "", page: null, section: null,
    category: "livret", corpus: "aec2027", provisional: false, text: "",
  });

  it("met devant un passage trouvé par les deux recherches, puis entrelace", () => {
    const parSens = [p("a", 0.86), p("b", 0.85), p("c", 0.84)];
    const parMots = [p("corrida", 0.79), p("b", 0.85)];
    expect(fuse(parSens, parMots).map((x) => x.id)).toEqual(["b", "a", "corrida", "c"]);
  });

  it("garde le score cosinus de chaque passage", () => {
    expect(fuse([p("a", 0.86)], [p("x", 0.7)]).map((x) => x.score)).toEqual([0.86, 0.7]);
  });
});
