import { RequestContext } from "@mastra/core/request-context";
import { aecAgent } from "../mastra/agents/aec.js";
import { COLLECTOR_KEY, PassageCollector } from "./collector.js";
import type { Answer, ReferencedPassage } from "./types.js";
import { verifyAnswer } from "./verify.js";

export interface RepondreOptions {
  /** Remplace le modèle de l'agent (comparaison dans les évals). */
  model?: string | object;
  /** Échanges précédents, pour les questions de suite. */
  historique?: { role: "user" | "assistant"; content: string }[];
}

export interface RepondreResult {
  reponse: Answer;
  /** Texte brut du modèle, avant vérification. */
  brut: string;
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

  return {
    reponse: verifyAnswer(result.text, collector),
    brut: result.text,
    passages: collector.all(),
    usage: {
      inputTokens: result.totalUsage?.inputTokens ?? 0,
      outputTokens: result.totalUsage?.outputTokens ?? 0,
    },
    traceId: result.traceId,
    spanId: result.spanId,
  };
}
