/** Jeu de données du calibrage des suites : étiquetage, fusion, tableau des seuils. */
import { describe, expect, it } from "vitest";
import { enParallele, etiqueter, fusionner, idPour, suitesDeSortie, tableauSeuils, type SuiteDonnee } from "../src/aec/suites-donnees.js";

const juge = (verdict: "repondu" | "partiel" | "introuvable") => ({ verdict, raison: "" });
const donnee = (question: string, extra: Partial<SuiteDonnee> = {}): SuiteDonnee => ({
  id: question,
  question,
  attendu: "repondu",
  origine: "passage",
  aRelire: false,
  ...extra,
});

describe("suitesDeSortie", () => {
  const brut = "Le programme prévoit la retraite à 60 ans [P1].\n\nPour aller plus loin :\n1. Comment serait-elle financée ?\n2. Et les carrières longues ?";
  it("lit les suites dans la sortie brute, chaîne ou { text }", () => {
    expect(suitesDeSortie(brut)).toEqual(["Comment serait-elle financée ?", "Et les carrières longues ?"]);
    expect(suitesDeSortie({ text: brut })).toHaveLength(2);
  });
  it("rien sans texte", () => {
    expect(suitesDeSortie(undefined)).toEqual([]);
    expect(suitesDeSortie({ object: {} })).toEqual([]);
  });
});

describe("etiqueter", () => {
  it("garde l'étiquette prévue et signale le désaccord du juge", () => {
    expect(etiqueter("passage", juge("repondu"))).toEqual({ attendu: "repondu", aRelire: false });
    expect(etiqueter("passage", juge("introuvable"))).toEqual({ attendu: "repondu", aRelire: true });
    expect(etiqueter("voisine", juge("repondu"))).toEqual({ attendu: "introuvable", aRelire: true });
  });
  it("suit le juge pour une suite réelle, et fait relire les « partiel »", () => {
    expect(etiqueter("reelle", juge("introuvable"))).toEqual({ attendu: "introuvable", aRelire: false });
    expect(etiqueter("reelle", juge("partiel"))).toEqual({ attendu: "partiel", aRelire: true });
  });
});

describe("fusionner", () => {
  it("ne remplace jamais une entrée existante (peut-être relue) et ignore les doublons", () => {
    const existant = [donnee("Et le SMIC ?", { attendu: "introuvable" })];
    const { donnees, ajoutees } = fusionner(existant, [donnee("et le smic?"), donnee("Et l'OTAN ?"), donnee("Et l'otan ?")]);
    expect(ajoutees).toBe(1);
    expect(donnees.map((d) => d.question)).toEqual(["Et le SMIC ?", "Et l'OTAN ?"]);
    expect(donnees[0]!.attendu).toBe("introuvable");
  });
});

it("idPour donne des identifiants uniques et lisibles", () => {
  const pris = new Set<string>();
  expect(idPour("voisine", "Et le changement d'heure ?", pris)).toBe("voisine-et-le-changement-d-heure");
  expect(idPour("voisine", "Et le changement d'heure ?", pris)).toBe("voisine-et-le-changement-d-heure-2");
});

it("enParallele garde l'ordre et respecte la limite", async () => {
  let enCours = 0;
  let max = 0;
  const out = await enParallele([30, 10, 20, 5, 15], 2, async (ms, i) => {
    max = Math.max(max, ++enCours);
    await new Promise((r) => setTimeout(r, ms));
    enCours--;
    return i;
  });
  expect(out).toEqual([0, 1, 2, 3, 4]);
  expect(max).toBe(2);
});

it("tableauSeuils compte faux positifs et suites retirées", () => {
  const lignes = tableauSeuils([0.85, 0.79], [0.807, 0.7]);
  const a = (s: number) => lignes.find((l) => l.seuil === s)!;
  expect(a(0.8)).toBeUndefined();
  expect(a(0.807)).toEqual({ seuil: 0.807, fauxPositifs: 1, retirees: 1 });
  expect(a(0.808)).toEqual({ seuil: 0.808, fauxPositifs: 0, retirees: 1 });
});
