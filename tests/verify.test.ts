import { describe, expect, it } from "vitest";
import { PassageCollector } from "../src/aec/collector.js";
import { INTROUVABLE_TEXTE, type RetrievedPassage } from "../src/aec/types.js";
import { splitSentences, verifyAnswer } from "../src/aec/verify.js";

const passage = (id: string, over: Partial<RetrievedPassage> = {}): RetrievedPassage => ({
  id, score: 0.9, docId: id.split("#")[0]!, title: "PROGRAMME SITE 2025",
  url: "https://melenchon2027.fr/wp-content/uploads/2025/02/A5-PROGRAMME-SITE.pdf",
  page: 33, category: "programme", corpus: "aec2027", provisional: true, text: "…", ...over,
});

function collectorWith(...ps: RetrievedPassage[]) {
  const c = new PassageCollector();
  c.add(ps);
  return c;
}

describe("verifyAnswer", () => {
  const c = () =>
    collectorWith(
      passage("wp:media:15699#p33#0"),
      passage("wp:media:15699#p33#1"), // même page que P1
      passage("wp:media:12357#p23#0", {
        title: "Livret_UP_21_EMPLOI_web-ok", page: 23, category: "livret", provisional: false,
        url: "https://melenchon2027.fr/wp-content/uploads/2024/02/Livret_UP_21_EMPLOI_web-ok.pdf",
      }),
    );

  it("renumérote les références et fusionne les passages d'une même page", () => {
    const a = verifyAnswer(
      "Le programme prévoit la retraite à 60 ans [P1]. Après 40 annuités [P2]. Le livret Emploi le confirme [P3].",
      c(),
    );
    expect(a.statut).toBe("repondu");
    expect(a.texte).toBe("Le programme prévoit la retraite à 60 ans [1]. Après 40 annuités [1]. Le livret Emploi le confirme [2].");
    expect(a.sources.map((s) => [s.n, s.page])).toEqual([[1, 33], [2, 23]]);
    expect(a.avertissements).toEqual(["Programme provisoire : une édition plus récente peut exister."]);
    expect(a.controle).toMatchObject({ citationsValides: 3, citationsRejetees: 0, phrasesRetirees: 0 });
  });

  it("retire une phrase qui ne cite qu'un passage jamais renvoyé par l'outil", () => {
    const a = verifyAnswer("La retraite à 60 ans [P1]. Le Bitcoin sera interdit [P9].", c());
    expect(a.texte).toBe("La retraite à 60 ans [1].");
    expect(a.controle).toMatchObject({ citationsRejetees: 1, phrasesRetirees: 1 });
  });

  it("garde une phrase dont au moins une référence est valide, sans la référence inventée", () => {
    const a = verifyAnswer("La retraite à 60 ans [P1][P7].", c());
    expect(a.texte).toBe("La retraite à 60 ans [1].");
    expect(a.controle.citationsRejetees).toBe(1);
  });

  it("accepte [P1, P3], la référence après le point, et les listes à puces", () => {
    const a = verifyAnswer("Deux sources :\n- retraite à 60 ans. [P1, P3]\n- 40 annuités [p2].", c());
    expect(a.texte).toBe("Deux sources :\n- retraite à 60 ans. [1][2]\n- 40 annuités [1].");
    expect(a.controle.phrasesSansSource).toBe(1);
  });

  it("devient « introuvable » si le modèle le dit ou si aucune citation ne tient", () => {
    expect(verifyAnswer("INTROUVABLE", c())).toMatchObject({ statut: "introuvable", texte: INTROUVABLE_TEXTE });
    expect(verifyAnswer("introuvable.", c()).statut).toBe("introuvable");
    expect(verifyAnswer("", c()).statut).toBe("introuvable");
    // Réponse de mémoire, sans aucune référence : refusée.
    expect(verifyAnswer("Le programme prévoit la retraite à 60 ans.", c()).statut).toBe("introuvable");
    const allFake = verifyAnswer("Le programme interdit TikTok [P42].", c());
    expect(allFake).toMatchObject({ statut: "introuvable", controle: { citationsRejetees: 1 } });
  });

  it("dit explicitement qu'une réponse s'appuie sur la version 2022, pas à jour", () => {
    const a = verifyAnswer("Retraite à 60 ans [P1].", collectorWith(passage("x#p1#0", { corpus: "aec2022", provisional: false })));
    expect(a.avertissements).toEqual([
      "Cette réponse s'appuie en partie sur la version 2022 du programme, qui n'est pas à jour : " +
        "le programme 2027 n'est pas encore publié en entier.",
    ]);
  });
});

describe("splitSentences", () => {
  it("rattache une référence isolée à la phrase précédente", () => {
    expect(splitSentences("Première phrase. [P1] Deuxième phrase [P2].")).toEqual(["Première phrase. [P1]", "Deuxième phrase [P2]."]);
  });
});

describe("PassageCollector", () => {
  it("donne la même référence à un passage retrouvé par une deuxième recherche", () => {
    const col = new PassageCollector();
    const [a] = col.add([passage("a")]);
    const [b, again] = col.add([passage("b"), passage("a")]);
    expect([a?.ref, b?.ref, again?.ref]).toEqual(["P1", "P2", "P1"]);
    expect(col.size).toBe(2);
  });
});

describe("joinChunks", () => {
  it("recolle les passages en retirant le chevauchement", async () => {
    const { joinChunks } = await import("../src/aec/search.js");
    const a = "Augmenter les salaires. Le SMIC sera porté à 1 600 euros net par mois pour tous.";
    const b = "porté à 1 600 euros net par mois pour tous. Revaloriser les APL de 10 %.";
    expect(joinChunks([a, b])).toBe("Augmenter les salaires. Le SMIC sera porté à 1 600 euros net par mois pour tous. Revaloriser les APL de 10 %.");
    expect(joinChunks(["Sans lien.", "Autre texte."])).toBe("Sans lien.\nAutre texte.");
  });
});
