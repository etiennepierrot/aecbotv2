import TurndownService from "turndown";
import { extractText, getDocumentProxy } from "unpdf";
import type { ExtractedDocument } from "./types.js";

/** PDF → texte page par page, pour garder le numéro de page de chaque passage. */
export async function extractPdf(data: Uint8Array): Promise<ExtractedDocument> {
  const pdf = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: false });
  return {
    pages: text.map((t, i) => ({ page: i + 1, text: cleanText(t) })),
  };
}

const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
turndown.remove(["script", "style", "noscript", "iframe", "form"]);

/** HTML (contenu rendu d'une page WordPress) → Markdown. */
export function extractHtml(html: string): ExtractedDocument {
  return { pages: [{ page: null, text: cleanText(turndown.turndown(html)) }] };
}

export function extractPlainText(text: string): ExtractedDocument {
  return { pages: [{ page: null, text: cleanText(text) }] };
}

function cleanText(t: string): string {
  return t
    .replace(/­/g, "") // césures invisibles
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
