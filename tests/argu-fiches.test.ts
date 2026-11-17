import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lireFiches } from "../src/argu/fiches.js";

const lire = (chemin: string) => JSON.parse(readFileSync(new URL(`../${chemin}`, import.meta.url), "utf8"));

/** Codes du référentiel « theme » tels que livrés par store.ts. */
const themesLivres = [...readFileSync(new URL("../src/argu/store.ts", import.meta.url), "utf8").matchAll(/\('theme',\s*'([a-z_]+)'/g)].map(
  (m) => m[1],
);

describe("fiches d'objections en brouillon", () => {
  const fiches = lireFiches(lire("argu/fiches-brouillon.json"));

  it("le fichier livré est valide", () => {
    expect(fiches.length).toBeGreaterThan(0);
  });

  it("chaque thème existe dans le référentiel", () => {
    expect(themesLivres.length).toBeGreaterThan(0);
    for (const f of fiches) if (f.theme !== null) expect(themesLivres, f.intitule).toContain(f.theme);
  });

  it("chaque question de evals/argumentaire.json renvoie à une fiche du fichier", () => {
    const intitules = new Set(fiches.map((f) => f.intitule));
    const questions = lire("evals/argumentaire.json") as { id: string; attendu: string; fiche?: string }[];
    for (const q of questions) {
      if (q.attendu === "repondu") expect(intitules, q.id).toContain(q.fiche);
      else expect(q.fiche, q.id).toBeUndefined();
    }
  });

  it("refuse un intitulé en double, casse ignorée", () => {
    const f = fiches[0]!;
    expect(() => lireFiches({ fiches: [f, { ...f, intitule: f.intitule.toUpperCase() }] })).toThrow(/double/);
  });

  it("refuse une fiche sans point d'appui", () => {
    expect(() => lireFiches({ fiches: [{ ...fiches[0], points_appui: [] }] })).toThrow();
  });
});
