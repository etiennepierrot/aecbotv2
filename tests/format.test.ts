import { describe, expect, it } from "vitest";
import type { Answer } from "../src/aec/types.js";
import { answerForMemory, formatAnswer, prettyTitle } from "../src/telegram/format.js";
import { pseudonymize } from "../src/telegram/privacy.js";

const answer: Answer = {
  statut: "repondu",
  texte: "Retraite à 60 ans [1]. Le livret <Emploi> & co le confirme [2].",
  sources: [
    { n: 1, title: "PROGRAMME SITE 2025", url: "https://melenchon2027.fr/wp-content/uploads/2025/02/A5-PROGRAMME-SITE.pdf", pages: [33], category: "programme", corpus: "aec2027", provisional: true },
    { n: 2, title: "Livret_UP_21_EMPLOI_web-ok", url: "https://melenchon2027.fr/x.pdf?a=1&b=\"2\"", pages: [23], category: "livret", corpus: "aec2027", provisional: false },
  ],
  avertissements: ["Programme provisoire : une édition plus récente peut exister."],
  controle: { passagesRecuperes: 3, citationsValides: 2, citationsRejetees: 0, phrasesRetirees: 0, phrasesSansSource: 0 },
};

describe("formatAnswer", () => {
  it("échappe le HTML, lie chaque source à sa page et ajoute les avertissements", () => {
    expect(formatAnswer(answer)).toBe(
      [
        "Retraite à 60 ans [1]. Le livret &lt;Emploi&gt; &amp; co le confirme [2].",
        '[1] <a href="https://melenchon2027.fr/wp-content/uploads/2025/02/A5-PROGRAMME-SITE.pdf#page=33">Programme L\'Avenir en commun</a>, page 33\n' +
          '[2] <a href="https://melenchon2027.fr/x.pdf?a=1&amp;b=&quot;2&quot;#page=23">Livret « emploi »</a>, page 23',
        "<i>Programme provisoire : une édition plus récente peut exister.</i>\n<i>Initiative non officielle, non endossée par LFI.</i>",
      ].join("\n\n"),
    );
  });

  it("marque une source de l'édition 2022 comme pas à jour", () => {
    const old = { ...answer, sources: [{ ...answer.sources[0]!, corpus: "aec2022" as const, provisional: false, title: "x" }] };
    expect(formatAnswer(old)).toContain("Programme L'Avenir en commun 2022 (version abrégée)</a>, page 33 (version 2022, pas à jour)");
  });

  it("reste sous la limite de Telegram", () => {
    const long = { ...answer, texte: "x".repeat(6000) };
    expect(formatAnswer(long).length).toBeLessThanOrEqual(4096);
    expect(formatAnswer(long)).toContain("Initiative non officielle");
  });

  it("garde en mémoire la réponse et ses sources, pas les URL", () => {
    expect(answerForMemory(answer)).toBe(
      "Retraite à 60 ans [1]. Le livret <Emploi> & co le confirme [2].\nSources : [1] Programme L'Avenir en commun p. 33 ; [2] Livret « emploi » p. 23",
    );
  });
});

describe("prettyTitle", () => {
  it.each([
    ["Livret_UP_13_SANTE_web-ok", "livret", "Livret « santé »"],
    ["Plan_UP_JUSTICE-FISCALE_web-3", "plan", "Plan « justice fiscale »"],
    ["Livret_UP_40_6e-REP_web (1)-ok", "livret", "Livret « 6e République »"],
    ["LIVRET-EDUCATION_AEC_WEB-ok", "livret", "Livret « éducation »"],
    ["M 27 PLAN BTP LOGEMENT", "publication_2026", "Plan « BTP logement »"],
    ["Comment nous allons remettre de l ordre dans les comptes publics", "publication_2026", "Comment nous allons remettre de l'ordre dans les comptes publics"],
    ["Note de l'équipe", "ajout_manuel", "Note de l'équipe"],
  ] as const)("%s", (title, cat, expected) => {
    expect(prettyTitle(title, cat)).toBe(expected);
  });
});

describe("pseudonymize", () => {
  it("est stable, dépend du secret et ne contient pas l'identifiant", () => {
    const a = pseudonymize(123456789, "s".repeat(32));
    expect(a).toBe(pseudonymize(123456789, "s".repeat(32)));
    expect(a).not.toBe(pseudonymize(123456789, "t".repeat(32)));
    expect(a).not.toContain("123456789");
    expect(a).toMatch(/^u_[0-9a-f]{24}$/);
  });
});

describe("markdownToTelegramHtml", () => {
  it("traduit le gras, l'italique, les listes et les titres, après échappement", async () => {
    const { markdownToTelegramHtml } = await import("../src/telegram/format.js");
    expect(markdownToTelegramHtml("Le programme prévoit **aucun soutien militaire** direct [1].")).toBe(
      "Le programme prévoit <b>aucun soutien militaire</b> direct [1].",
    );
    expect(markdownToTelegramHtml("- sortie de l'OTAN\n* renforcer l'ONU")).toBe("• sortie de l'OTAN\n• renforcer l'ONU");
    expect(markdownToTelegramHtml("### Paix\nune *paix durable* <b>")).toBe("<b>Paix</b>\nune <i>paix durable</i> &lt;b&gt;");
    expect(markdownToTelegramHtml("gras **non refermé")).toBe("gras non refermé");
    expect(markdownToTelegramHtml("5 * 3 = 15 et 2*x")).toBe("5 * 3 = 15 et 2*x");
  });
});

describe("sources et commandes d'équipe", () => {
  it("affiche toutes les pages citées d'un document", () => {
    const multi = { ...answer, sources: [{ ...answer.sources[1]!, n: 1, pages: [3, 21, 23] }] };
    expect(formatAnswer(multi)).toContain('#page=3">Livret « emploi »</a>, pages 3, 21, 23');
  });

  it("affiche un document de l'équipe sans lien public", () => {
    const team = {
      ...answer,
      sources: [{ n: 1, title: "Note interne", url: "", pages: [2], category: "ajout_manuel" as const, corpus: "aec2027" as const, provisional: false }],
    };
    expect(formatAnswer(team)).toContain("[1] Note interne, page 2 (document de l'équipe)");
  });

  it("lit les commandes /ajouter", async () => {
    const { parseAjouter } = await import("../src/telegram/bot.js");
    expect(parseAjouter("https://x.fr/a.pdf Mon titre")).toEqual({ title: "Mon titre", url: "https://x.fr/a.pdf" });
    expect(parseAjouter("Titre\nTexte\nsuite")).toEqual({ title: "Titre", text: "Texte\nsuite" });
    expect(parseAjouter("https://x.fr/a.pdf")).toBeUndefined();
    expect(parseAjouter("Titre seul")).toBeUndefined();
  });
});

describe("suites", () => {
  it("numérote les suites après les sources, et rappelle la question choisie", () => {
    const msg = formatAnswer({ ...answer, suites: ["Comment la financer ?", "Et les <femmes> ?"] }, "Et le SMIC ?");
    expect(msg.startsWith("🔎 <b>Et le SMIC ?</b>\n\nRetraite à 60 ans [1].")).toBe(true);
    expect(msg).toContain("page 23\n\n<b>Pour aller plus loin</b>\n1. Comment la financer ?\n2. Et les &lt;femmes&gt; ?\n");
    expect(msg.endsWith("<i>Initiative non officielle, non endossée par LFI.</i>")).toBe(true);
  });
});
