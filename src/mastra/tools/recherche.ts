import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { COLLECTOR_KEY, PassageCollector } from "../../aec/collector.js";
import { searchPassages } from "../../aec/search.js";
import type { ReferencedPassage } from "../../aec/types.js";

const CATEGORY_LABELS: Record<string, string> = {
  programme: "programme général",
  livret: "livret thématique",
  plan: "plan",
  publication_2026: "publication 2026",
  page: "page du site",
  ajout_manuel: "document ajouté par l'équipe",
};

const passageOut = z.object({
  ref: z.string(),
  title: z.string(),
  url: z.string(),
  page: z.number().nullable(),
  section: z.string().nullable(),
  category: z.string(),
  corpus: z.string(),
  score: z.number(),
  text: z.string(),
});

export const rechercheTool = createTool({
  id: "recherche",
  description:
    "Cherche dans L'Avenir en commun (programme, livrets, plans, publications) les passages qui " +
    "répondent à une requête. Renvoie des passages numérotés P1, P2… à citer tels quels.",
  inputSchema: z.object({
    requete: z.string().min(2).describe("Mots-clés ou reformulation précise de la question"),
    edition: z
      .enum(["toutes", "aec2027", "aec2022"])
      .default("toutes")
      .describe("« toutes » par défaut ; une édition précise seulement si la question en nomme une"),
  }),
  outputSchema: z.object({ passages: z.array(passageOut), erreur: z.string().optional() }),
  execute: async ({ requete, edition }, context) => {
    // Le collecteur est fourni par repondre() ; dans Studio on en crée un jetable.
    const collector =
      (context?.requestContext?.get(COLLECTOR_KEY as never) as PassageCollector | undefined) ?? new PassageCollector();
    let found;
    try {
      found = await searchPassages({ requete, edition });
    } catch (e) {
      // Noté pour repondre(), qui en fera une erreur : sans ça, la panne passerait pour « introuvable ».
      // On ne relance pas l'exception : le modèle réessaierait jusqu'à maxSteps pour rien.
      const message = e instanceof Error ? e.message : String(e);
      collector.errors.push(message);
      return { passages: [], erreur: message };
    }
    const referenced = collector.add(found);
    return {
      passages: referenced.map((p) => ({
        ref: p.ref,
        title: p.title,
        url: p.url,
        page: p.page,
        section: p.section,
        category: p.category,
        corpus: p.corpus,
        score: p.score,
        text: p.text,
      })),
    };
  },
  // Ce que voit le modèle : passages compacts, sans URL ni score.
  toModelOutput: ({ passages, erreur }) => ({
    type: "text",
    value: erreur
      ? "ERREUR : la recherche est indisponible. Ne réessaie pas ; réponds uniquement INTROUVABLE."
      : formatForModel(passages),
  }),
});

export function formatForModel(
  passages: (Pick<ReferencedPassage, "ref" | "title" | "page" | "text"> & {
    section?: string | null;
    category: string;
    corpus: string;
  })[],
): string {
  if (passages.length === 0) return "Aucun passage trouvé pour cette requête.";
  return passages
    .map((p) => {
      // EPUB : la section remplace la page (le rang interne n'a pas de sens pour le lecteur).
      const where = p.section ? `section « ${p.section} »` : p.page ? `page ${p.page}` : "page web";
      const kind = CATEGORY_LABELS[p.category] ?? p.category;
      const archive = p.corpus === "aec2022" ? ", ÉDITION 2022, PAS À JOUR" : "";
      return `[${p.ref}] ${p.title} — ${where} (${kind}${archive})\n${p.text}`;
    })
    .join("\n\n");
}
