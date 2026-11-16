import { inflateRawSync } from "node:zlib";
import { htmlToMarkdown } from "./extract.js";

/** Une section du livre : l'équivalent d'une page PDF pour la citation. */
export interface EpubSection {
  /** Rang de la section dans le livre (1, 2…) : sert de « page » interne (regroupement, élargissement). */
  page: number;
  /** Chemin lisible : « Partie 3 : … › Chapitre 1 : … › Garantir une retraite digne ». */
  section: string;
  text: string;
}

export interface EpubBook {
  title: string;
  /** dcterms:modified, ou dc:date, en ISO. */
  modified: string;
  sections: EpubSection[];
}

export const SECTION_SEPARATOR = " › ";

/** Dernier élément du chemin : le titre de la section seule. */
export function sectionTitle(path: string): string {
  return path.split(SECTION_SEPARATOR).at(-1) ?? path;
}

export function isEpub(data: Uint8Array): boolean {
  if (data[0] !== 0x50 || data[1] !== 0x4b) return false; // « PK » : une archive zip
  return new TextDecoder().decode(data.slice(30, 70)).includes("application/epub+zip");
}

/**
 * EPUB → sections, dans l'ordre de lecture (spine). Un fichier par partie ou chapitre ;
 * chaque `<section>` d'un chapitre devient une entrée, le texte hors section (ouverture
 * de partie, introduction) aussi. Le titre du chemin est répété en tête du texte : il aide
 * la recherche (« retraite » dans « Garantir une retraite digne »).
 */
export function readEpub(data: Uint8Array): EpubBook {
  if (!isEpub(data)) throw new Error("Ce fichier n'est pas un EPUB.");
  const files = unzip(data);
  const read = (name: string) => {
    const f = files.get(name);
    if (f === undefined) throw new Error(`EPUB incomplet : ${name} manquant`);
    return f;
  };

  const container = read("META-INF/container.xml");
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath) throw new Error("EPUB sans fichier OPF");
  const opf = read(opfPath);
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

  const title = decodeEntities(/<dc:title[^>]*>([^<]+)</.exec(opf)?.[1]?.trim() ?? "Livre");
  const modifiedRaw =
    /<meta property="dcterms:modified">([^<]+)</.exec(opf)?.[1] ?? /<dc:date[^>]*>([^<]+)</.exec(opf)?.[1];
  const modified = modifiedRaw && !Number.isNaN(Date.parse(modifiedRaw)) ? new Date(modifiedRaw).toISOString() : new Date(0).toISOString();

  const manifest = new Map<string, string>();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(m[0])?.[1];
    const href = /\bhref="([^"]+)"/.exec(m[0])?.[1];
    if (id && href && /application\/xhtml\+xml/.test(m[0]) && !/properties="nav"/.test(m[0])) manifest.set(id, href);
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => manifest.get(m[1]!)).filter((h): h is string => !!h);

  const sections: EpubSection[] = [];
  let partie = "";
  const push = (path: string[], html: string) => {
    const body = htmlToMarkdown(prepare(html));
    if (body.replace(/\s/g, "").length < 40) return;
    const section = path.filter(Boolean).join(SECTION_SEPARATOR);
    // Une section longue (l'introduction) est coupée entre deux paragraphes : chaque morceau
    // reste assez court pour être rendu en entier à l'agent, sous le même titre de section.
    for (const part of splitParagraphs(body, MAX_SECTION_CHARS)) {
      sections.push({ page: sections.length + 1, section, text: `${section}\n\n${part}` });
    }
  };

  for (const href of spine) {
    const html = files.get(decodeURIComponent(base + href));
    if (!html) continue;
    // Couverture, page de titre, table des matières : rien à indexer.
    if (/class="(?:cover-container|titlepage-container|toc-container)"/.test(html)) continue;
    const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? html;

    const partLabel = /class="part-label">([^<]+)</.exec(body)?.[1];
    if (partLabel) {
      const heading = decodeEntities(stripTags(/class="part-heading">([\s\S]*?)<\/h1>/.exec(body)?.[1] ?? ""));
      partie = `${decodeEntities(partLabel.trim())} : ${heading}`;
      // Le sommaire des chapitres de la partie n'apporte rien à la recherche.
      push([partie], body.replace(/<div class="part-chapters-summary">[\s\S]*?<\/ul>\s*<\/div>/, "").replace(/<h1[\s\S]*?<\/h1>|<div class="part-label">[^<]*<\/div>/g, ""));
      continue;
    }

    const chapitre = decodeEntities(stripTags(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(body)?.[1] ?? ""));
    const isIntro = /class="chapter-eyebrow">\s*Introduction/.test(body);
    const header = isIntro ? [chapitre] : [partie, chapitre];
    const sectionRe = /<section\b[^>]*>([\s\S]*?)<\/section>/g;
    const outside = body.replace(sectionRe, "").replace(/<header[\s\S]*?<\/header>|<div class="chapter-header">[\s\S]*?<\/h1>\s*<\/div>/g, "");
    push(header, outside);
    for (const m of body.matchAll(sectionRe)) {
      const inner = m[1]!;
      const h2 = decodeEntities(stripTags(/<h2[^>]*>([\s\S]*?)<\/h2>/.exec(inner)?.[1] ?? ""));
      push([...header, h2], inner.replace(/<h2[\s\S]*?<\/h2>/, ""));
    }
  }
  if (sections.length === 0) throw new Error("EPUB sans texte exploitable");
  return { title, modified, sections };
}

/** En dessous de MAX_PAGE_CHARS (recherche) : une section est toujours rendue en entier. */
const MAX_SECTION_CHARS = 5000;

export function splitParagraphs(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let current = "";
  for (const para of text.split(/\n{2,}/)) {
    if (current && current.length + para.length + 2 > max) {
      parts.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${para}` : para;
  }
  if (current) parts.push(current);
  return parts;
}

/** Les encadrés « Mesure clé » deviennent une ligne en gras, lisible une fois en Markdown. */
function prepare(html: string): string {
  return html.replace(
    /<div class="mesure-cle-badge">\s*Mesure clé\s*<\/div>\s*<p class="mesure-cle-text">/g,
    "<p><strong>Mesure clé :</strong> ",
  );
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Lecteur zip minimal (répertoire central, méthodes « stocké » et « deflate ») : un EPUB
 * n'utilise rien d'autre, et cela évite une dépendance. Seuls les fichiers texte sont lus.
 */
export function unzip(data: Uint8Array): Map<string, string> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Archive zip illisible");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  const utf8 = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("Répertoire zip illisible");
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = utf8.decode(data.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!/\.(?:x?html?|opf|xml|ncx)$/i.test(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = data.subarray(start, start + compressed);
    if (method === 0) out.set(name, utf8.decode(raw));
    else if (method === 8) out.set(name, utf8.decode(inflateRawSync(raw)));
  }
  return out;
}
