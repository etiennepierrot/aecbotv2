import { describe, expect, it } from "vitest";
import { creerControleObjet, estPartielle } from "../src/aec/objet.js";
import type { ReferencedPassage } from "../src/aec/types.js";
import { fakeModel } from "./helpers/fake-model.js";

const passage: ReferencedPassage = {
  ref: "P1", id: "x", score: 0.8, docId: "manual:livre-aec", title: "L'Avenir en commun (livre, édition 2026)", url: "",
  page: 12, section: "Partie 3 › Chapitre 1 › Réduire le temps de travail", category: "programme", corpus: "aec2027",
  provisional: false, text: "Réduire le temps de travail à 32 heures.",
};

describe("contrôle de l'objet", () => {
  it("reconnaît une réponse partielle à sa première phrase", () => {
    expect(estPartielle("Je ne trouve pas de passage qui réponde précisément à cette question.\n\nLe programme…")).toBe(true);
    expect(estPartielle("Le programme prévoit la retraite à 60 ans [1].")).toBe(false);
  });

  it("envoie la question et les passages cités, et lit le verdict JSON du modèle", async () => {
    let vu = "";
    const model = fakeModel((prompt) => {
      vu = JSON.stringify(prompt);
      return { text: JSON.stringify({ objet: "le changement d'heure", traite: false, raison: "le passage parle du temps de travail" }) };
    });
    const verdict = await creerControleObjet(model)("Le programme veut-il supprimer le changement d'heure ?", [passage]);
    expect(verdict).toEqual({ objet: "le changement d'heure", traite: false, raison: "le passage parle du temps de travail" });
    expect(vu).toContain("changement d'heure");
    expect(vu).toContain("Réduire le temps de travail à 32 heures.");
    expect(vu).toContain("Réduire le temps de travail"); // la section du livre
  });
});
