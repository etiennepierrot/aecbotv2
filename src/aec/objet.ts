import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { defaultModels } from "../config.js";
import type { ReferencedPassage } from "./types.js";

/** La phrase par laquelle l'agent annonce une réponse partielle (règle 4 de ses instructions). */
export const PARTIEL = /^\W*Je ne trouve pas de passage qui réponde précisément/i;

export const estPartielle = (texte: string) => PARTIEL.test(texte);

export interface VerdictObjet {
  /** Ce sur quoi porte précisément la question, selon le contrôleur. */
  objet: string;
  /** Un passage cité traite-t-il de cet objet lui-même (et pas seulement du même thème) ? */
  traite: boolean;
  raison: string;
}

export type ControleObjet = (question: string, passages: ReferencedPassage[]) => Promise<VerdictObjet>;

/** Modèle du contrôle : AEC_CHECK_MODEL, sinon le juge des évals (le contrôle est rare, il doit être sûr). */
export const CHECK_MODEL = process.env.AEC_CHECK_MODEL?.trim() || defaultModels().judge;

const verdictSchema = z.object({ objet: z.string(), traite: z.boolean(), raison: z.string() });

const controleur = new Agent({
  id: "aec-controle-objet",
  name: "Contrôle de l'objet",
  description: "Dit si des passages traitent de l'objet précis d'une question, ou seulement du même thème.",
  instructions: `
Tu contrôles un assistant documentaire. On te donne une question et des passages d'un programme politique.
1. Nomme l'objet précis de la question : la mesure, l'institution ou le dispositif qu'elle désigne,
   en quelques mots (« la gratuité des transports scolaires », pas « les transports »).
   L'objet est la chose dont parle la question, pas ce que la question suppose qu'on en fera :
   - une question sur ce que fera une personne (un candidat, un ministre) porte sur la mesure ou
     l'institution concernée : « La ministre démissionnera-t-elle si le référendum d'initiative
     citoyenne est adopté ? » porte sur le référendum d'initiative citoyenne. Le programme ne
     parle pas des intentions des personnes ;
   - une question qui prête au programme un geste sur une chose (la supprimer, la privatiser, en
     sortir, la confisquer) porte sur cette chose : « Le programme veut-il privatiser la SNCF ? »
     porte sur la SNCF. Un passage qui dit ce que le programme en fait (la garder, la réformer,
     la taxer, renégocier ses règles) traite de cet objet, même sans le mot de la question.
2. Dis si au moins un passage traite de CET objet lui-même : il le nomme, ou décrit une mesure qui
   porte directement sur lui. Un passage qui traite seulement du même thème, ou d'une mesure voisine,
   ne compte pas.
Exemples hors sujet : une question sur les radars automatiques et un passage sur les transports en
commun ; une question sur la réforme de l'orthographe et un passage sur les moyens de l'école.
Exemple qui compte : une question sur la durée d'un mandat et un passage qui décrit ce mandat.
Tu réponds en JSON.`.trim(),
  model: CHECK_MODEL,
  defaultOptions: { modelSettings: { temperature: 0 } },
});

/** Le contrôle réel : un appel court, seulement pour les réponses partielles. `model` : essais. */
export const creerControleObjet = (model?: object): ControleObjet => async (question, passages) => {
  const contexte = passages
    .map((p) => `[${p.ref}] ${p.title}${p.section ? `, « ${p.section} »` : p.page ? `, page ${p.page}` : ""}\n${p.text}`)
    .join("\n\n");
  const res = await controleur.generate(`Question : ${question}\n\nPassages :\n${contexte}`, {
    structuredOutput: { schema: verdictSchema },
    ...(model ? { model: model as never } : {}),
  });
  return verdictSchema.parse(res.object);
};

export const controleObjet: ControleObjet = creerControleObjet();
