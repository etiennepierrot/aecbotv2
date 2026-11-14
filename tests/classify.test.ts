import { describe, expect, it } from "vitest";
import manifest from "./fixtures/manifest-ancien-pipeline.json" with { type: "json" };
import { classifyByMetadata, isExtractionUsable } from "../src/corpus/classify.js";
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
    expect(cls.included).toBe(d.included);
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
    // Programme 2025 et publications 2026 restent dans l'édition actuelle.
    for (const d of manifest.filter((x) => x.included && (x.category === "programme" || x.category === "publication_2026"))) {
      expect(corpusOf(d)).toBe("aec2027");
    }
  });

  it("marque le programme général comme provisoire", () => {
    const cls = classifyByMetadata(pdf("PROGRAMME SITE 2025", "https://x/wp-content/uploads/2025/02/A5-PROGRAMME-SITE.pdf"));
    expect(cls).toMatchObject({ category: "programme", provisional: true, corpus: "aec2027" });
  });

  it("respecte le classement imposé de l'édition 2022, malgré « abrégée » dans le titre", async () => {
    const { EDITION_2022 } = await import("../src/corpus/sources.js");
    expect(classifyByMetadata(EDITION_2022[0]!)).toEqual({
      category: "programme", corpus: "aec2022", included: true, reason: "", provisional: false,
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
