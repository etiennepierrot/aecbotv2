import { z } from "zod";
import { CATEGORIES } from "./types.js";

export const sourceItemSchema = z.object({
  id: z.string(),
  origin: z.enum(["wordpress", "manuel"]),
  kind: z.enum(["pdf", "html", "text"]),
  title: z.string(),
  url: z.string(),
  modified: z.string(),
  inlineContent: z.string().optional(),
  telegramFileId: z.string().optional(),
  addedBy: z.string().optional(),
  inlinePages: z.array(z.object({ page: z.number(), text: z.string(), section: z.string().optional() })).optional(),
  forced: z.object({ category: z.enum(CATEGORIES), corpus: z.enum(["aec2027", "aec2022"]) }).optional(),
});

export const extractedSchema = z.object({
  pages: z.array(z.object({ page: z.number().nullable(), text: z.string(), section: z.string().optional() })),
});

export const classificationSchema = z.object({
  category: z.enum(CATEGORIES),
  corpus: z.enum(["aec2027", "aec2022"]),
  included: z.boolean(),
  reason: z.string(),
  provisional: z.boolean(),
});

export const passageSchema = z.object({
  id: z.string(),
  text: z.string(),
  metadata: z.record(z.string(), z.unknown()),
});

export const documentResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["indexé", "écarté", "erreur"]),
  category: z.enum(CATEGORIES).optional(),
  passages: z.number(),
  detail: z.string(),
});
export type DocumentResult = z.infer<typeof documentResultSchema>;
