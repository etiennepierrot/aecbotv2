/**
 * Contrat d'une capture : le même pour tous les canaux (extension, /capter, RSS, Assemblée).
 * La route POST /capture, le bot et les collectes passent tous par enregistrerCapture(), qui
 * valide avec ces schémas : une seule définition, donc un seul jeu de règles.
 */
import { z } from "zod";

export const SOURCE_TYPES = ["x", "youtube", "telegram_texte", "telegram_image", "rss", "assemblee", "web"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Sources sans URL : le texte vient directement d'un message Telegram. */
const SANS_URL: readonly SourceType[] = ["telegram_texte", "telegram_image"];

export const AUTEUR_TYPES = ["personnalite", "organisation", "media", "particulier", "inconnu"] as const;

/** Par où la capture est arrivée (la colonne `canal`) ; `source_type` dit d'où vient le contenu. */
export const CANAUX = ["extension", "telegram", "rss", "assemblee", "cli"] as const;
export type Canal = (typeof CANAUX)[number];

export const CAPTURE_STATUTS = ["recue", "traitee", "erreur"] as const;

/** Au-delà, la route répond 413 plutôt que 422 : la capture est valide mais trop grosse. */
export const TEXTE_MAX = 50_000;
export const NOTE_MAX = 500;

export const CaptureInput = z
  .object({
    source_type: z.enum(SOURCE_TYPES),
    url: z
      .string()
      .url()
      .refine((u) => u.startsWith("https://"), "URL absolue en https attendue")
      .optional(),
    texte: z.string().trim().min(1, "texte vide").max(TEXTE_MAX),
    auteur: z
      .object({
        nom: z.string().trim().max(200).optional(),
        identifiant: z.string().trim().max(200).optional(),
      })
      .optional(),
    publie_le: z.string().datetime({ offset: true }).optional(),
    /** Post cité, suite d'un fil, horodatage et transcription d'une vidéo, chiffres d'audience. */
    extras: z.record(z.string(), z.unknown()).optional(),
    note: z.string().trim().max(NOTE_MAX).optional(),
  })
  .superRefine((c, ctx) => {
    if (!c.url && !SANS_URL.includes(c.source_type)) {
      ctx.addIssue({ code: "custom", path: ["url"], message: `url obligatoire pour une source « ${c.source_type} »` });
    }
  });
export type CaptureInput = z.infer<typeof CaptureInput>;
