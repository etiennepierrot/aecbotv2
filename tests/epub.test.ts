import { describe, expect, it } from "vitest";
import { chunkDocument } from "../src/corpus/chunk.js";
import { classifyByMetadata } from "../src/corpus/classify.js";
import { isEpub, readEpub, sectionTitle, splitParagraphs } from "../src/corpus/epub.js";
import type { SourceItem } from "../src/corpus/types.js";
import { makeEpub } from "./helpers/epub.js";
import { makePdf } from "./helpers/pdf.js";

describe("readEpub", () => {
  const livre = readEpub(makeEpub());

  it("lit le titre, la date et les sections dans l'ordre du livre", () => {
    expect(livre.title).toBe("L'Avenir en commun");
    expect(livre.modified).toBe("2026-11-10T23:00:00.000Z");
    expect(livre.sections.map((s) => s.section)).toEqual([
      "Introduction : Vers une nouvelle France",
      "Partie 3 : Mettre en sécurité sociale",
      "Partie 3 : Mettre en sécurité sociale › Chapitre 1 : À chacun selon ses besoins › Éradiquer la pauvreté",
      "Partie 3 : Mettre en sécurité sociale › Chapitre 1 : À chacun selon ses besoins › Garantir une retraite digne",
    ]);
    expect(livre.sections.map((s) => s.page)).toEqual([1, 2, 3, 4]);
  });

  it("garde la mesure clé, les mesures et le chemin de la section dans le texte", () => {
    const retraite = livre.sections[3]!;
    expect(retraite.text.startsWith(retraite.section)).toBe(true);
    expect(retraite.text).toContain("**Mesure clé :** Abroger la reforme Macron puis abaisser");
    expect(retraite.text).toContain("Porter les pensions au niveau du SMIC & du seuil de pauvreté");
    expect(retraite.text).not.toContain("<");
    // Le sommaire de la partie et la couverture ne sont pas indexés.
    expect(livre.sections[1]!.text).not.toContain("Chapitre 1");
    expect(sectionTitle(retraite.section)).toBe("Garantir une retraite digne");
  });

  it("refuse un fichier qui n'est pas un EPUB", () => {
    expect(isEpub(makePdf([["x"]]))).toBe(false);
    expect(() => readEpub(makePdf([["x"]]))).toThrow(/pas un EPUB/);
  });

  it("coupe une section trop longue entre deux paragraphes", () => {
    const paras = Array.from({ length: 6 }, (_, i) => `${i}`.repeat(1000));
    const parts = splitParagraphs(paras.join("\n\n"), 2500);
    expect(parts).toHaveLength(3);
    expect(parts.join("\n\n")).toBe(paras.join("\n\n"));
  });

  it("chaque passage porte sa section, cité à la place de la page", async () => {
    const item: SourceItem = {
      id: "manual:livre-aec", origin: "manuel", kind: "pdf", title: "L'Avenir en commun (livre, édition 2026)", url: "",
      modified: livre.modified, forced: { category: "programme", corpus: "aec2027" },
    };
    const passages = await chunkDocument(item, { pages: livre.sections }, classifyByMetadata(item));
    const retraite = passages.find((p) => p.text.includes("retraite a 60 ans"));
    expect(retraite?.metadata).toMatchObject({
      page: 4, section: livre.sections[3]!.section, category: "programme", provisional: false, corpus: "aec2027",
    });
  });
});
