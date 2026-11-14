import { describe, expect, it } from "vitest";
import { chunkDocument } from "../src/corpus/chunk.js";
import { classifyByMetadata } from "../src/corpus/classify.js";
import { extractHtml, extractPdf } from "../src/corpus/extract.js";
import type { SourceItem } from "../src/corpus/types.js";
import { makePdf } from "./helpers/pdf.js";

const item: SourceItem = {
  id: "wp:media:15699", origin: "wordpress", kind: "pdf", title: "PROGRAMME SITE 2025",
  url: "https://melenchon2027.fr/wp-content/uploads/2025/02/A5-PROGRAMME-SITE.pdf", modified: "2025-02-18T10:00:00.000Z",
};

describe("extraction et découpage", () => {
  it("garde le numéro de page de chaque passage", async () => {
    const pdf = makePdf([
      ["Introduction generale du programme."],
      ["Retablir la retraite a 60 ans apres 40 annees de cotisation."],
      ["Planification ecologique et regle verte."],
    ]);
    const extracted = await extractPdf(pdf);
    expect(extracted.pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(extracted.pages[1]?.text).toContain("retraite a 60 ans");

    const passages = await chunkDocument(item, extracted, classifyByMetadata(item));
    const retraite = passages.find((p) => p.text.includes("60 ans"));
    expect(retraite?.metadata).toMatchObject({
      page: 2, docId: item.id, category: "programme", provisional: true, url: item.url, title: item.title,
    });
    expect(retraite?.metadata.text).toBe(retraite?.text);
    expect(new Set(passages.map((p) => p.id)).size).toBe(passages.length);
  });

  it("coupe une page longue en plusieurs passages de la même page", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `Phrase numero ${i} sur les services publics et la bifurcation.`);
    const passages = await chunkDocument(item, { pages: [{ page: 7, text: long.join(" ") }] }, classifyByMetadata(item));
    expect(passages.length).toBeGreaterThan(1);
    expect(passages.every((p) => p.metadata.page === 7 && p.text.length <= 1200)).toBe(true);
  });

  it("convertit le HTML en Markdown sans scripts", () => {
    const out = extractHtml("<h2>Retraites</h2><p>Retour à 60 ans.</p><script>alert(1)</script>");
    expect(out.pages[0]?.text).toBe("## Retraites\n\nRetour à 60 ans.");
    expect(out.pages[0]?.page).toBeNull();
  });
});
