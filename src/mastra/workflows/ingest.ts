import { createHash, randomUUID } from "node:crypto";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { chunkDocument } from "../../corpus/chunk.js";
import { classifyByMetadata, isExtractionUsable, normalizeForHash } from "../../corpus/classify.js";
import { ingestDeps } from "../../corpus/deps.js";
import { extractHtml, extractPdf, extractPlainText } from "../../corpus/extract.js";
import {
  classificationSchema,
  documentResultSchema,
  extractedSchema,
  passageSchema,
  sourceItemSchema,
} from "../../corpus/schemas.js";
import { CATEGORIES, type SourceItem } from "../../corpus/types.js";

/* ------------------------------------------------------------------ */
/* Entrées : deux portes, un seul workflow                             */
/* ------------------------------------------------------------------ */

const scanInput = z.object({
  mode: z.literal("scan"),
  /** Réindexer même les documents inchangés. */
  force: z.boolean().default(false),
  /** Traiter au plus N documents (essais). */
  limit: z.number().int().positive().optional(),
  /** Autoriser le retrait de plus de 20 % des documents connus en une fois. */
  allowMassRemoval: z.boolean().default(false),
});

const manualInput = z.object({
  mode: z.literal("manuel"),
  title: z.string().min(1),
  /** Lien vers un PDF ou une page web. */
  url: z.string().url().optional(),
  /** Ou bien le texte lui-même. */
  text: z.string().optional(),
  /** Ou bien un PDF déjà extrait page par page (fichier envoyé au bot, fichier local), ou les sections d'un EPUB. */
  pages: z.array(z.object({ page: z.number(), text: z.string(), section: z.string().optional() })).optional(),
  telegramFileId: z.string().optional(),
  addedBy: z.string(),
  /** Identifiant fixe (manual:…) : un nouvel ajout remplace le précédent au lieu de s'y ajouter. */
  id: z.string().regex(/^manual:[\w-]+$/).optional(),
  /** Classement imposé : le livre du programme est le programme, pas un « ajout manuel ». */
  forced: z.object({ category: z.enum(CATEGORIES), corpus: z.enum(["aec2027", "aec2022"]) }).optional(),
  /** Date de la version (ISO) ; par défaut, maintenant. */
  modified: z.string().optional(),
});

export const ingestInputSchema = z.discriminatedUnion("mode", [scanInput, manualInput]);

/** Au-delà, on suspecte une panne du site plutôt qu'un vrai retrait. */
const MAX_REMOVAL_RATIO = 0.2;

/* ------------------------------------------------------------------ */
/* 1. Détecter                                                         */
/* ------------------------------------------------------------------ */

const detecter = createStep({
  id: "detecter",
  description:
    "Scan : compare l'API WordPress (id + date de modif) au registre et retire les documents disparus. " +
    "Ajout manuel : passe directement à la suite.",
  inputSchema: ingestInputSchema,
  outputSchema: z.array(sourceItemSchema),
  stateSchema: z.object({
    removed: z.array(z.string()).default([]),
    unchanged: z.number().default(0),
    warnings: z.array(z.string()).default([]),
  }),
  execute: async ({ inputData, setState, state }) => {
    if (inputData.mode === "manuel") {
      if (!inputData.url && !inputData.text && !inputData.pages?.length) {
        throw new Error("Ajout manuel : il faut un lien, un texte ou un PDF");
      }
      const kind = inputData.pages?.length
        ? "pdf"
        : inputData.text
          ? "text"
          : /\.pdf($|\?)/i.test(inputData.url!)
            ? "pdf"
            : "html";
      const item: SourceItem = {
        id: inputData.id ?? `manual:${randomUUID()}`,
        origin: "manuel",
        kind,
        title: inputData.title,
        url: inputData.url ?? "",
        modified: inputData.modified ?? new Date().toISOString(),
        forced: inputData.forced,
        inlineContent: inputData.text,
        inlinePages: inputData.pages,
        telegramFileId: inputData.telegramFileId,
        addedBy: inputData.addedBy,
      };
      return [item];
    }

    const { source, store } = await ingestDeps();
    const remote = await source.listItems();
    if (remote.length === 0) throw new Error("L'API WordPress n'a renvoyé aucun document : scan interrompu");

    const known = new Map((await store.listDocuments("wordpress")).map((d) => [d.id, d]));
    const remoteIds = new Set(remote.map((i) => i.id));

    const changed = remote.filter((i) => {
      const k = known.get(i.id);
      return (
        inputData.force ||
        !k ||
        new Date(k.modified).getTime() !== new Date(i.modified).getTime() ||
        // Une règle de classement a changé (ancienne version du programme écartée) : on retire ses passages.
        (k.included && !classifyByMetadata(i).included)
      );
    });

    const gone = [...known.keys()].filter((id) => !remoteIds.has(id));
    const warnings: string[] = [];
    if (gone.length > 0 && gone.length > known.size * MAX_REMOVAL_RATIO && !inputData.allowMassRemoval) {
      warnings.push(
        `${gone.length} documents ont disparu du site sur ${known.size} : retrait annulé par précaution ` +
          `(relancer avec allowMassRemoval si c'est voulu).`,
      );
    } else {
      for (const id of gone) await store.removeDocument(id);
    }

    // Les plus récents d'abord : en cas de doublon exact, on garde le dernier téléversé.
    changed.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
    const selected = inputData.limit ? changed.slice(0, inputData.limit) : changed;

    await setState({
      ...state,
      removed: warnings.length ? [] : gone,
      unchanged: remote.length - changed.length,
      warnings,
    });
    return selected;
  },
});

/* ------------------------------------------------------------------ */
/* 2 à 5 : un sous-workflow par document                               */
/* ------------------------------------------------------------------ */

const recupererOut = z.object({
  item: sourceItemSchema,
  extracted: extractedSchema.nullable(),
  error: z.string().optional(),
});

const recuperer = createStep({
  id: "recuperer",
  description: "Pages HTML → Markdown ; PDF → texte page par page.",
  inputSchema: sourceItemSchema,
  outputSchema: recupererOut,
  execute: async ({ inputData: item }) => {
    try {
      const { source } = await ingestDeps();
      let extracted;
      // Écarté d'après son titre (archive NFP, ancienne version du programme…) : rien à télécharger.
      if (!classifyByMetadata(item).included) extracted = { pages: [] };
      else if (item.inlinePages?.length) extracted = { pages: item.inlinePages };
      else if (item.kind === "text") extracted = extractPlainText(item.inlineContent ?? "");
      else if (item.kind === "html")
        extracted = extractHtml(item.inlineContent ?? new TextDecoder().decode(await source.download(item.url)));
      else extracted = await extractPdf(await source.download(item.url));
      return { item, extracted };
    } catch (e) {
      return { item, extracted: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
});

const classerOut = recupererOut.extend({
  cls: classificationSchema,
  contentHash: z.string().nullable(),
});

const classer = createStep({
  id: "classer",
  description:
    "Catégorie (programme, livret, plan, publication 2026, page, ajout manuel), origine, validité. " +
    "Doublons exacts, archives NFP 2024 et documents secondaires écartés.",
  inputSchema: recupererOut,
  outputSchema: classerOut,
  execute: async ({ inputData }) => {
    const { item, extracted } = inputData;
    const cls = classifyByMetadata(item);
    if (!extracted) return { ...inputData, cls, contentHash: null };

    const contentHash = createHash("sha256").update(normalizeForHash(extracted)).digest("hex");
    if (cls.included && !isExtractionUsable(extracted)) {
      return { ...inputData, contentHash, cls: { ...cls, included: false, reason: "Extraction non exploitable" } };
    }
    if (cls.included) {
      const { store } = await ingestDeps();
      const dup = await store.findDuplicate(item.id, contentHash);
      if (dup) return { ...inputData, contentHash, cls: { ...cls, included: false, reason: `Doublon exact de ${dup}` } };
    }
    return { ...inputData, cls, contentHash };
  },
});

const decouperOut = classerOut.extend({ passages: z.array(passageSchema) });

const decouper = createStep({
  id: "decouper",
  description: "MDocument, un découpage par page PDF pour garder le numéro de page en métadonnée.",
  inputSchema: classerOut,
  outputSchema: decouperOut,
  execute: async ({ inputData }) => {
    const { item, extracted, cls } = inputData;
    if (!extracted || !cls.included) return { ...inputData, passages: [] };
    return { ...inputData, passages: await chunkDocument(item, extracted, cls) };
  },
});

const indexer = createStep({
  id: "indexer",
  description: "Embeddings → upsert pgvector, en remplaçant les passages d'un document modifié.",
  inputSchema: decouperOut,
  outputSchema: documentResultSchema,
  execute: async ({ inputData }) => {
    const { item, extracted, cls, passages, contentHash, error } = inputData;
    if (error || !extracted) {
      // Rien n'est enregistré : le document sera retenté au prochain scan.
      return { id: item.id, title: item.title, status: "erreur" as const, passages: 0, detail: error ?? "" };
    }
    const { store, embedder } = await ingestDeps();
    const vectors = passages.length ? await embedder.embed(passages.map((p) => p.text)) : [];
    await store.saveDocument({
      item,
      cls,
      pages: extracted.pages.length,
      characters: extracted.pages.reduce((n, p) => n + p.text.length, 0),
      contentHash,
      passages: passages.map((p) => ({ ...p, metadata: p.metadata as never })),
      vectors,
    });
    return {
      id: item.id,
      title: item.title,
      status: cls.included ? ("indexé" as const) : ("écarté" as const),
      category: cls.category,
      passages: passages.length,
      detail: cls.reason,
    };
  },
});

export const ingestDocumentWorkflow = createWorkflow({
  id: "ingest-document",
  description: "Récupérer, classer, découper et indexer un document.",
  inputSchema: sourceItemSchema,
  outputSchema: documentResultSchema,
})
  .then(recuperer)
  .then(classer)
  .then(decouper)
  .then(indexer)
  .commit();

/* ------------------------------------------------------------------ */
/* Workflow principal                                                  */
/* ------------------------------------------------------------------ */

const summaryOut = z.object({
  documents: z.array(documentResultSchema),
  indexed: z.number(),
  excluded: z.number(),
  errors: z.number(),
  unchanged: z.number(),
  removed: z.array(z.string()),
  warnings: z.array(z.string()),
});

const resumer = createStep({
  id: "resumer",
  inputSchema: z.array(documentResultSchema),
  outputSchema: summaryOut,
  stateSchema: z.object({
    removed: z.array(z.string()).default([]),
    unchanged: z.number().default(0),
    warnings: z.array(z.string()).default([]),
  }),
  execute: async ({ inputData, state }) => ({
    documents: inputData,
    indexed: inputData.filter((d) => d.status === "indexé").length,
    excluded: inputData.filter((d) => d.status === "écarté").length,
    errors: inputData.filter((d) => d.status === "erreur").length,
    unchanged: state.unchanged,
    removed: state.removed,
    warnings: state.warnings,
  }),
});

const cron = process.env.INGEST_CRON?.trim();

export const ingestWorkflow = createWorkflow({
  id: "ingest",
  description: "Scan nocturne du WordPress du programme, ou ajout manuel d'un document par l'équipe.",
  inputSchema: ingestInputSchema,
  outputSchema: summaryOut,
  stateSchema: z.object({
    removed: z.array(z.string()).default([]),
    unchanged: z.number().default(0),
    warnings: z.array(z.string()).default([]),
  }),
  ...(cron
    ? {
        schedule: {
          id: "scan-nocturne",
          cron,
          timezone: "Europe/Paris",
          inputData: { mode: "scan" as const, force: false, allowMassRemoval: false },
        },
      }
    : {}),
})
  .then(detecter)
  // Un document à la fois : la détection de doublons reste déterministe.
  .foreach(ingestDocumentWorkflow, { concurrency: 1 })
  .then(resumer)
  .commit();
