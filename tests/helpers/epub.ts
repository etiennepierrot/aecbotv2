import { crc32 } from "node:zlib";

/**
 * Un EPUB minimal, avec la structure du livre-programme : une partie, un chapitre à deux
 * sections (avec encadré « Mesure clé »), une introduction. Archive zip non compressée.
 */
export function makeEpub(opts: { modified?: string; retraite?: string } = {}): Uint8Array {
  const retraite = opts.retraite ?? "abaisser l'age de depart jusqu'a restaurer la retraite a 60 ans";
  const page = (title: string, body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${body}</body></html>`;
  const long = (sujet: string) =>
    Array.from({ length: 8 }, (_, i) => `Phrase ${i} sur ${sujet}, pour atteindre une longueur realiste.`).join(" ");
  const files: [string, string][] = [
    ["mimetype", "application/epub+zip"],
    ["META-INF/container.xml", `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`],
    [
      "OEBPS/content.opf",
      `<package><metadata><dc:title>L'Avenir en commun</dc:title><meta property="dcterms:modified">${opts.modified ?? "2026-11-10T23:00:00Z"}</meta></metadata>
<manifest>
<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
<item id="intro" href="intro.xhtml" media-type="application/xhtml+xml"/>
<item id="p3" href="partie3.xhtml" media-type="application/xhtml+xml"/>
<item id="p3c1" href="partie3_chapitre1.xhtml" media-type="application/xhtml+xml"/>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
</manifest><spine><itemref idref="cover"/><itemref idref="intro"/><itemref idref="p3"/><itemref idref="p3c1"/></spine></package>`,
    ],
    ["OEBPS/cover.xhtml", page("Couverture", `<div class="cover-container"><img src="cover.jpg"/></div>`)],
    [
      "OEBPS/intro.xhtml",
      page("Intro", `<div class="chapter-header"><div class="chapter-eyebrow">Introduction</div><h1 class="chapter-title">Introduction : Vers une nouvelle France</h1></div><p>${long("la nouvelle France")}</p>`),
    ],
    [
      "OEBPS/partie3.xhtml",
      page("Partie 3", `<div class="part-opener"><div class="part-label">Partie 3</div><h1 class="part-heading">Mettre en sécurité sociale</h1><div class="part-intro-box"><p>${long("la securite sociale")}</p></div><div class="part-chapters-summary"><ul><li>Chapitre 1</li></ul></div></div>`),
    ],
    [
      "OEBPS/partie3_chapitre1.xhtml",
      page(
        "Chapitre 1",
        `<div class="chapter-container"><header class="chapter-header"><div class="chapter-eyebrow">Partie 3</div><h1 class="chapter-title">Chapitre 1 : À chacun selon ses besoins</h1></header>
<section class="section-container"><h2 class="section-title">Éradiquer la pauvreté</h2><p class="first-p">${long("la pauvrete")}</p></section>
<section class="section-container"><h2 class="section-title">Garantir une retraite digne</h2><p class="first-p">${long("les retraites")}</p>
<div class="mesure-cle-box"><div class="mesure-cle-badge">Mesure clé</div><p class="mesure-cle-text">Abroger la reforme Macron puis ${retraite}</p></div>
<ul class="mesures-list"><li class="mesure">Porter les pensions au niveau du SMIC &amp; du seuil de pauvreté</li></ul></section></div>`,
      ),
    ],
  ];
  return zipStored(files);
}

function zipStored(files: [string, string][]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const n = Buffer.from(enc.encode(name));
    const data = Buffer.from(enc.encode(content));
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}
