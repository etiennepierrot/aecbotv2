import { describe, expect, it } from "vitest";
import { PassageCollector } from "../src/aec/collector.js";
import { INTROUVABLE_TEXTE, type RetrievedPassage } from "../src/aec/types.js";
import { extractSuites, splitSentences, verifyAnswer } from "../src/aec/verify.js";

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

  it("renumérote les références : un numéro par document, avec ses pages", () => {
    const a = verifyAnswer(
      "Le programme prévoit la retraite à 60 ans [P1]. Après 40 annuités [P2]. Le livret Emploi le confirme [P3].",
      c(),
    );
    expect(a.statut).toBe("repondu");
    expect(a.texte).toBe("Le programme prévoit la retraite à 60 ans [1]. Après 40 annuités [1]. Le livret Emploi le confirme [2].");
    expect(a.sources.map((s) => [s.n, s.pages])).toEqual([[1, [33]], [2, [23]]]);
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

  it("regroupe plusieurs pages d'un même document sous un seul numéro", () => {
    const col = collectorWith(
      passage("d#p21#0", { page: 21, url: "https://x/paix.pdf", title: "Livret paix" }),
      passage("d#p3#0", { page: 3, url: "https://x/paix.pdf", title: "Livret paix" }),
      passage("d#p23#0", { page: 23, url: "https://x/paix.pdf", title: "Livret paix" }),
    );
    const a = verifyAnswer("Non-alignement [P1][P2]. Sortie de l'OTAN [P3].", col);
    expect(a.texte).toBe("Non-alignement [1]. Sortie de l'OTAN [1].");
    expect(a.sources).toHaveLength(1);
    expect(a.sources[0]!.pages).toEqual([3, 21, 23]);
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

describe("suites d'approfondissement", () => {
  const c = () => collectorWith(passage("wp:media:15699#p33#0"));

  it("sépare le bloc SUITES de la réponse, sans le compter comme phrases sans source", () => {
    const a = verifyAnswer(
      "Retraite à 60 ans [P1].\n\nSUITES :\n1. Comment serait-elle financée ? [P1]\n2. **Et les carrières longues ?** [P1]\n3. Et la pénibilité ? [P1, P9]",
      c(),
    );
    expect(a.texte).toBe("Retraite à 60 ans [1].");
    expect(a.suites).toEqual(["Comment serait-elle financée ?", "Et les carrières longues ?", "Et la pénibilité ?"]);
    expect(a.controle.phrasesSansSource).toBe(0);
    expect(a.controle.suitesSansPassage).toBe(0);
  });

  it("écarte une suite sans référence, ou dont la référence n'a pas été renvoyée", () => {
    const a = verifyAnswer(
      "Retraite à 60 ans [P1].\nSUITES :\n1. Et le financement ?\n2. Et le calendrier ? [P7]\n3. Et les carrières longues ? [P1]",
      c(),
    );
    expect(a.suites).toEqual(["Et les carrières longues ?"]);
    expect(a.controle.suitesSansPassage).toBe(2);
  });

  it("garde 3 suites au plus parmi celles qui citent un passage", () => {
    const lignes = ["A ?", "B ?", "C ?", "D ?", "E ?"].map((q, i) => `${i + 1}. Question ${q}${i === 0 ? "" : " [P1]"}`);
    const a = verifyAnswer(`Retraite à 60 ans [P1].\nSUITES :\n${lignes.join("\n")}`, c());
    expect(a.suites).toEqual(["Question B ?", "Question C ?", "Question D ?"]);
  });

  it("accepte « Pour aller plus loin », ne garde que de vraies questions courtes, 3 au plus, sans doublon", () => {
    const { suites } = extractSuites(
      [
        "Réponse.", "**Pour aller plus loin :**",
        "- Quel calendrier ?", "- Quel calendrier ?", "- Une affirmation.", `- ${"x".repeat(130)} ?`,
        "- Quel financement ?", "- Quelles exceptions ?", "- Une de trop ?",
      ].join("\n"),
    );
    expect(suites).toEqual(["Quel calendrier ?", "Quel financement ?", "Quelles exceptions ?"]);
  });

  it("pas de suites sur une réponse introuvable", () => {
    expect(verifyAnswer("INTROUVABLE\nSUITES :\n1. Et la retraite ?", c()).suites).toBeUndefined();
  });
});
