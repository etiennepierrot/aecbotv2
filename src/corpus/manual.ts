import type { Mastra } from "@mastra/core";
import type { DocumentResult } from "./schemas.js";
import { ingestDeps } from "./deps.js";
import { isEpub, readEpub } from "./epub.js";
import { extractPdf } from "./extract.js";

/** Au-delà, Telegram ne laisse de toute façon pas un bot télécharger le fichier. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

export interface AjoutManuel {
  title: string;
  url?: string;
  text?: string;
  pdf?: Uint8Array;
  /** Qui ajoute : prénom Telegram et pseudonyme, ou « cli:<utilisateur> ». */
  addedBy: string;
  telegramFileId?: string;
}

/**
 * Ajoute un document au corpus sans passer par WordPress : lien (PDF ou page web), texte,
 * ou fichier PDF. Passe par le workflow d'ingestion (mode « manuel ») : mêmes contrôles
 * (texte exploitable, doublon) et mêmes métadonnées que le scan, catégorie « ajout_manuel ».
 */
export async function ajouterDocument(mastra: Mastra, a: AjoutManuel): Promise<DocumentResult> {
  const title = a.title.trim();
  if (title.length < 3) throw new Error("Il faut un titre (3 caractères au moins).");
  if (a.pdf && a.pdf.length > MAX_PDF_BYTES) throw new Error("PDF trop gros (20 Mo au plus).");
  const pages = a.pdf
    ? isEpub(a.pdf)
      ? readEpub(a.pdf).sections
      : (await extractPdf(a.pdf)).pages.map((p) => ({ page: p.page ?? 0, text: p.text }))
    : undefined;

  const run = await mastra.getWorkflow("ingest").createRun();
  const res = await run.start({
    inputData: {
      mode: "manuel",
      title,
      url: a.url,
      text: a.text,
      pages,
      telegramFileId: a.telegramFileId,
      addedBy: a.addedBy,
    },
  });
  if (res.status !== "success") {
    const err = (res as { error?: { message?: string } }).error;
    throw new Error(err?.message ?? `Ajout impossible (${res.status})`);
  }
  const doc = res.result.documents[0];
  if (!doc) throw new Error("Ajout impossible : aucun document traité");
  const { store } = await ingestDeps();
  await store.logAdmin({ who: a.addedBy, action: "ajouter", docId: doc.id, title, detail: `${doc.status} ${doc.detail}`.trim() });
  return doc;
}

/** Identifiant fixe du livre : l'ajouter de nouveau remplace la version précédente. */
export const LIVRE_ID = "manual:livre-aec";

/**
 * Le livre du programme (EPUB), seule version du programme qui fait foi. Indexé section par
 * section, cité par titre de section, sans lien public. Rangé en `programme`, édition 2027
 * (la plus récente), non provisoire. Le texte ne vit que dans la base : le dépôt est public.
 */
export async function ajouterLivre(mastra: Mastra, epub: Uint8Array, addedBy: string): Promise<DocumentResult> {
  const livre = readEpub(epub);
  const annee = new Date(livre.modified).getUTCFullYear();
  const title = `${livre.title} (livre, édition ${annee})`;
  const run = await mastra.getWorkflow("ingest").createRun();
  const res = await run.start({
    inputData: {
      mode: "manuel",
      id: LIVRE_ID,
      title,
      pages: livre.sections,
      modified: livre.modified,
      forced: { category: "programme", corpus: "aec2027" },
      addedBy,
    },
  });
  if (res.status !== "success") {
    const err = (res as { error?: { message?: string } }).error;
    throw new Error(err?.message ?? `Ajout impossible (${res.status})`);
  }
  const doc = res.result.documents[0];
  if (!doc) throw new Error("Ajout impossible : aucun document traité");
  const { store } = await ingestDeps();
  await store.logAdmin({ who: addedBy, action: "ajouter", docId: doc.id, title, detail: `${doc.status} ${doc.detail}`.trim() });
  return doc;
}

export async function listerDocuments() {
  const { store } = await ingestDeps();
  return store.listManualDocuments();
}

/** Identifiant court affiché dans /docs : les 8 premiers caractères après « manual: ». */
export function shortId(id: string): string {
  return id.replace(/^manual:/, "").slice(0, 8);
}

/**
 * Retire un document ajouté à la main (jamais un document du WordPress : le scan le remettrait).
 * Accepte l'identifiant complet ou court.
 */
export async function supprimerDocument(idOuCourt: string, who: string): Promise<{ id: string; title: string }> {
  const { store } = await ingestDeps();
  const wanted = idOuCourt.trim().replace(/^manual:/, "").toLowerCase();
  if (wanted.length < 4) throw new Error("Donne l'identifiant affiché par /docs.");
  const matches = (await store.listManualDocuments()).filter((d) => d.id.replace(/^manual:/, "").startsWith(wanted));
  if (matches.length === 0) throw new Error(`Aucun document ajouté à la main ne correspond à « ${idOuCourt} ».`);
  if (matches.length > 1) throw new Error(`Plusieurs documents correspondent à « ${idOuCourt} » : donne plus de caractères.`);
  const doc = matches[0]!;
  await store.removeDocument(doc.id);
  await store.logAdmin({ who, action: "supprimer", docId: doc.id, title: doc.title });
  return { id: doc.id, title: doc.title };
}
