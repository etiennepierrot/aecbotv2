import { RequestContext } from "@mastra/core/request-context";
import { aecAgent } from "../mastra/agents/aec.js";
import { COLLECTOR_KEY, PassageCollector } from "./collector.js";
import { controleObjet, estPartielle, type ControleObjet } from "./objet.js";
import { INTROUVABLE_TEXTE, type Answer, type ReferencedPassage } from "./types.js";
import { filtrerSuites } from "./suites.js";
import { passagesCites, verifyAnswer } from "./verify.js";

export interface RepondreOptions {
  /** Remplace le modèle de l'agent (comparaison dans les évals). */
  model?: string | object;
  /** Échanges précédents, pour les questions de suite. */
  historique?: { role: "user" | "assistant"; content: string }[];
  /** Contrôle des réponses partielles (remplaçable en test). */
  controleObjet?: ControleObjet;
}

export interface RepondreResult {
  reponse: Answer;
  /** Texte brut du modèle, avant vérification. */
  brut: string;
  /** Suites qui citent un passage valide, avant le filtre par score (calibrage, mesures). */
  suitesAvantFiltre: string[];
  passages: ReferencedPassage[];
  usage: { inputTokens: number; outputTokens: number };
  traceId?: string;
  /** Span racine de la trace : le feedback s'y attache. */
  spanId?: string;
}

/**
 * Point d'entrée unique pour répondre à une question (bot, évals) :
 * l'agent cherche et rédige, puis la réponse est vérifiée contre les
 * passages réellement renvoyés par l'outil de recherche.
 */
export async function repondre(question: string, opts: RepondreOptions = {}): Promise<RepondreResult> {
  const collector = new PassageCollector();
  const requestContext = new RequestContext();
  requestContext.set(COLLECTOR_KEY, collector);

  const messages = [
    ...(opts.historique ?? []).map((m) =>
      m.role === "user" ? { role: "user" as const, content: m.content } : { role: "assistant" as const, content: m.content },
    ),
    { role: "user" as const, content: question },
  ];
  const result = await aecAgent.generate(messages, {
    requestContext,
    // Première étape : appel de l'outil obligatoire. Sans ça, le modèle répond parfois
    // « INTROUVABLE » de lui-même, sans avoir cherché (question polémique, suite de conversation).
    prepareStep: ({ stepNumber }) => (stepNumber === 0 ? { toolChoice: "required" as const } : undefined),
    ...(opts.model ? { model: opts.model as never } : {}),
  });
  if (result.error) throw result.error;
  if (collector.errors.length > 0 && collector.size === 0) {
    // La recherche a échoué : ce n'est pas « rien trouvé », c'est une panne.
    throw new Error(`Recherche impossible : ${collector.errors[0]}`);
  }

  let reponse = verifyAnswer(result.text, collector);

  // Réponse partielle : le modèle a tendance à la remplir de mesures voisines (sécurité routière
  // pour une question sur les 80 km/h). Un contrôle court, seulement dans ce cas, vérifie que les
  // passages cités traitent de l'objet précis de la question ; sinon, la réponse est introuvable.
  if (reponse.statut === "repondu" && estPartielle(reponse.texte)) {
    try {
      const v = await (opts.controleObjet ?? controleObjet)(question, passagesCites(result.text, collector));
      const objet = { verdict: v.traite ? ("oui" as const) : ("non" as const), objet: v.objet, raison: v.raison };
      reponse = v.traite
        ? { ...reponse, controle: { ...reponse.controle, objet } }
        : { statut: "introuvable", texte: INTROUVABLE_TEXTE, sources: [], avertissements: [], controle: { ...reponse.controle, objet } };
    } catch (e) {
      // Panne du contrôle : la réponse, déjà vérifiée citation par citation, est gardée.
      reponse.controle.objet = { verdict: "erreur", raison: e instanceof Error ? e.message : String(e) };
    }
  }

  const suitesAvantFiltre = reponse.suites ?? [];
  // On ne propose que des suites que le corpus sait servir.
  if (reponse.suites?.length) {
    const { gardees, retirees } = await filtrerSuites(reponse.suites);
    reponse.suites = gardees;
    reponse.controle.suitesRetirees = retirees;
  }

  return {
    reponse,
    brut: result.text,
    suitesAvantFiltre,
    passages: collector.all(),
    usage: {
      inputTokens: result.totalUsage?.inputTokens ?? 0,
      outputTokens: result.totalUsage?.outputTokens ?? 0,
    },
    traceId: result.traceId,
    spanId: result.spanId,
  };
}
