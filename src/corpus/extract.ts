import TurndownService from "turndown";
import { extractText, getDocumentProxy } from "unpdf";
import type { ExtractedDocument } from "./types.js";

/** PDF → texte page par page, pour garder le numéro de page de chaque passage. */
export async function extractPdf(data: Uint8Array): Promise<ExtractedDocument> {
  // Un lien mort renvoie souvent une page HTML (redirection, 404 habillée) au lieu du PDF.
  const head = new TextDecoder().decode(data.slice(0, 1024));
  if (!head.includes("%PDF-")) {
    const kind = /<html|<!doctype/i.test(head) ? "une page HTML" : "autre chose qu'un PDF";
    throw new Error(`Le lien renvoie ${kind} (${data.length} octets) : lien mort ou redirigé ?`);
  }
  // verbosity 0 : pdf.js ne signale que les erreurs (pas les « TT: undefined function » des polices).
  const pdf = await getDocumentProxy(data, { verbosity: 0 });
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
