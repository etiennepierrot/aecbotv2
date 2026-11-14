import { randomUUID } from "node:crypto";
import type { Mastra } from "@mastra/core";
import { EntityType, type FeedbackEvent } from "@mastra/core/observability";

export interface FeedbackTarget {
  traceId: string;
  /** Span racine de la réponse : c'est sur lui que le Studio affiche le feedback. */
  spanId: string | null;
  pseudo: string;
}

/** Où vont les votes et commentaires des militants (Mastra en production, faux en test). */
export interface FeedbackSink {
  vote(args: FeedbackTarget & { value: 1 | -1 }): Promise<void>;
  comment(args: FeedbackTarget & { comment: string }): Promise<void>;
  /** /oublier : efface les traces (et le feedback qui y est attaché). */
  forgetTraces(traceIds: string[]): Promise<void>;
}

interface ObservabilityStore {
  createFeedback(args: { feedback: Record<string, unknown> }): Promise<void>;
  batchDeleteTraces?(args: { traceIds: string[] }): Promise<void>;
}

/** Destination secondaire du feedback (Mastra Cloud) : un échec n'y fait pas perdre le vote. */
export interface FeedbackCopy {
  onFeedbackEvent(event: FeedbackEvent): Promise<void>;
}

/**
 * Feedback Mastra, écrit directement dans le stockage d'observabilité (base Neon).
 *
 * On n'utilise pas `mastra.observability.addFeedback()` : il relit la trace dans le stockage, et
 * les spans y arrivent par lots avec quelques secondes de retard. Un clic rapide sur 👍/👎
 * tombait avant, et le vote était abandonné sans erreur. L'écriture directe ne dépend pas de ce délai.
 * `copy` reçoit le même feedback (Mastra Cloud), pour le tableau de bord de la plateforme.
 */
export function mastraFeedbackSink(mastra: Mastra, copy?: FeedbackCopy): FeedbackSink {
  const store = async (): Promise<ObservabilityStore> => {
    const s = (await mastra.getStorage()?.getStore("observability")) as unknown as ObservabilityStore | undefined;
    if (!s?.createFeedback) throw new Error("Stockage d'observabilité sans feedback (PostgresStoreVNext requis)");
    return s;
  };
  const entity = { entityType: EntityType.AGENT, entityId: "aec", entityName: "aec", serviceName: "aecbot" };
  const write = async (t: FeedbackTarget, fields: { feedbackType: string; value: number | string; comment?: string }) => {
    const base = {
      feedbackId: randomUUID(),
      timestamp: new Date(),
      traceId: t.traceId,
      ...(t.spanId ? { spanId: t.spanId } : {}),
      feedbackSource: "user",
      feedbackUserId: t.pseudo,
      ...fields,
    };
    await (await store()).createFeedback({ feedback: { ...base, ...entity } });
    // Déjà enregistré dans Neon : la copie ne doit jamais faire échouer le vote.
    await copy
      ?.onFeedbackEvent({ type: "feedback", feedback: { ...base, correlationContext: entity } })
      .catch(() => {});
  };
  return {
    vote: ({ value, ...t }) => write(t, { feedbackType: "thumbs", value }),
    comment: ({ comment, ...t }) => write(t, { feedbackType: "comment", value: comment, comment }),
    forgetTraces: async (traceIds) => {
      if (traceIds.length === 0) return;
      const s = await store();
      await s.batchDeleteTraces?.({ traceIds });
    },
  };
}
