import { MDocument } from "@mastra/rag";
import type { Classification, ExtractedDocument, PassageMetadata, SourceItem } from "./types.js";

export interface Passage {
  id: string;
  text: string;
  metadata: PassageMetadata;
}

/** Environ 300 jetons par passage, avec un léger chevauchement. */
const MAX_SIZE = 1200;
const OVERLAP = 150;

/**
 * Un découpage par page PDF : chaque passage garde le numéro de la page
 * d'où il vient, ce qui permet de citer « page N ». Pour un EPUB, la « page » est
 * une section, citée par son titre.
 */
export async function chunkDocument(
  item: SourceItem,
  extracted: ExtractedDocument,
  cls: Classification,
): Promise<Passage[]> {
  const passages: Passage[] = [];
  for (const { page, text, section } of extracted.pages) {
    if (text.trim().length < 20) continue;
    const doc = item.kind === "html" ? MDocument.fromMarkdown(text) : MDocument.fromText(text);
    const chunks = await doc.chunk({ strategy: "recursive", maxSize: MAX_SIZE, overlap: OVERLAP });
    chunks.forEach((c, i) => {
      const chunkText = c.text.trim();
      if (!chunkText) return;
      passages.push({
        id: `${item.id}#p${page ?? 0}#${i}`,
        // EPUB : chaque passage est embarqué avec le chemin de sa section, pas seulement le premier
        // (« corrida », au milieu d'une liste, n'a de sens que sous « Rompre avec la maltraitance animale »).
        // Le texte rendu à l'agent (metadata.text) reste le passage seul : l'élargissement à la
        // section entière ne répète pas le titre.
        text: section && !chunkText.startsWith(section) ? `${section}\n\n${chunkText}` : chunkText,
        metadata: {
          docId: item.id,
          title: item.title,
          url: item.url,
          page,
          section: section ?? null,
          category: cls.category,
          corpus: cls.corpus,
          origin: item.origin,
          modified: item.modified,
          provisional: cls.provisional,
          text: chunkText,
        },
      });
    });
  }
  return passages;
}
