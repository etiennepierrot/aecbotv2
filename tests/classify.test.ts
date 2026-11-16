import { describe, expect, it } from "vitest";
import manifest from "./fixtures/manifest-ancien-pipeline.json" with { type: "json" };
import { ANCIEN_PROGRAMME, classifyByMetadata, isExtractionUsable } from "../src/corpus/classify.js";
import type { SourceItem } from "../src/corpus/types.js";

const pdf = (title: string, url: string): SourceItem => ({
  id: "wp:media:1", origin: "wordpress", kind: "pdf", title, url, modified: "2026-01-01T00:00:00Z",
});

describe("classifyByMetadata", () => {
  // Les doublons et les extractions vides se décident sur le contenu, pas sur le titre.
  const byTitle = manifest.filter((d) => !/^Doublon|Extraction/.test(d.reason));

  it.each(byTitle.map((d) => [d.title, d] as const))("%s : même décision que l'ancien pipeline", (_, d) => {
    const cls = classifyByMetadata(pdf(d.title, d.url));
    expect(cls.category).toBe(d.category);
    // Seul écart voulu : les anciennes versions du programme ne sont plus interrogées (livre 2026).
    expect(cls.included).toBe(d.category === "programme" ? false : d.included);
  });

  it("classe aussi par catégorie les doublons, qui seront écartés après lecture", () => {
    for (const d of manifest.filter((x) => x.reason.startsWith("Doublon"))) {
      expect(classifyByMetadata(pdf(d.title, d.url)).category).toBe(d.category);
    }
  });

  it("range les livrets et plans de la campagne 2022 dans l'édition 2022", () => {
    const corpusOf = (d: (typeof manifest)[number]) => classifyByMetadata(pdf(d.title, d.url)).corpus;
    const included = manifest.filter((d) => d.included && (d.category === "livret" || d.category === "plan"));
    const current = included.filter((d) => corpusOf(d) === "aec2027").map((d) => d.title);
    // Seul le plan Europe n'est pas identifié comme document de 2022.
    expect(current).toEqual(["PLAN-EUROPE_AVENIR-EN-COMMUN"]);
    expect(included.length).toBeGreaterThan(50);
    // Les publications 2026 restent dans l'édition actuelle.
    for (const d of manifest.filter((x) => x.included && x.category === "publication_2026")) {
      expect(corpusOf(d)).toBe("aec2027");
    }
  });

  it("écarte les anciennes versions du programme publiées sur le site", () => {
    const cls = classifyByMetadata(pdf("PROGRAMME SITE 2025", "https://x/wp-content/uploads/2025/02/A5-PROGRAMME-SITE.pdf"));
    expect(cls).toMatchObject({ category: "programme", included: false, reason: ANCIEN_PROGRAMME });
  });

  it("garde le livre du programme, ajouté à la main avec un classement imposé", () => {
    const livre: SourceItem = {
      id: "manual:livre-aec", origin: "manuel", kind: "pdf", title: "L'Avenir en commun (livre, édition 2026)",
      url: "", modified: "2026-11-10T23:00:00Z", forced: { category: "programme", corpus: "aec2027" },
    };
    expect(classifyByMetadata(livre)).toEqual({
      category: "programme", corpus: "aec2027", included: true, reason: "", provisional: false,
    });
  });

  it("range les pages HTML et les ajouts manuels à part", () => {
    expect(classifyByMetadata({ ...pdf("Retraites", "https://x/programme/retraites/"), kind: "html" }).category).toBe("page");
    expect(classifyByMetadata({ ...pdf("Note", ""), origin: "manuel", kind: "text" }).category).toBe("ajout_manuel");
  });
});

describe("isExtractionUsable", () => {
  it("refuse un PDF quasi vide (scanné)", () => {
    expect(isExtractionUsable({ pages: Array.from({ length: 10 }, (_, i) => ({ page: i + 1, text: "12" })) })).toBe(false);
  });
  it("accepte un PDF avec du texte", () => {
    expect(isExtractionUsable({ pages: [{ page: 1, text: "x".repeat(800) }] })).toBe(true);
  });
});

describe("pages et articles du site", () => {
  const html = (id: string, title: string): SourceItem => ({
    id, origin: "wordpress", kind: "html", title, url: "https://melenchon2027.fr/programme/x/", modified: "2026-01-01T00:00:00Z",
  });
  it("garde les chapitres, chantiers et pages du programme", () => {
    expect(classifyByMetadata(html("wp:post:23208", "Chapitre 7 : La force de l’entraide")).included).toBe(true);
    expect(classifyByMetadata(html("wp:post:17914", "Chantier cadre : Retrouver les moyens d’agir")).included).toBe(true);
    expect(classifyByMetadata(html("wp:page:26139", "Comment nous allons reconstruire notre système de santé")).included).toBe(true);
  });
  it("écarte les comparateurs avec d'autres partis et les articles d'actualité", () => {
    expect(classifyByMetadata(html("wp:post:17901", "Comparateur Place Publique 2025 – Régénérer la démocratie"))).toMatchObject({
      included: false, reason: "Comparateur avec le programme d'un autre parti",
    });
    expect(classifyByMetadata(html("wp:post:13653", "Non, Gérard Depardieu ne rend pas fière la France"))).toMatchObject({
      included: false, reason: "Article d'actualité exclu par défaut",
    });
  });
});
