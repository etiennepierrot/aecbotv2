import type { Mastra } from "@mastra/core";

/** Où vont les votes et commentaires des militants (Mastra en production, faux en test). */
export interface FeedbackSink {
  vote(args: { traceId: string; pseudo: string; value: 1 | -1 }): Promise<void>;
  comment(args: { traceId: string; pseudo: string; comment: string }): Promise<void>;
  /** /oublier : efface les traces (et le feedback qui y est attaché). */
  forgetTraces(traceIds: string[]): Promise<void>;
}

/**
 * Feedback Mastra : chaque vote s'attache à la trace de la réponse, visible dans le Studio
 * (onglet Feedback de la trace) avec la question, les recherches et les passages reçus.
 */
export function mastraFeedbackSink(mastra: Mastra): FeedbackSink {
  const add = async (traceId: string, feedback: Record<string, unknown>) => {
    const addFeedback = mastra.observability.addFeedback;
    if (!addFeedback) throw new Error("Feedback non pris en charge : observabilité Mastra non configurée");
    await addFeedback.call(mastra.observability, { traceId, feedback: feedback as never });
  };
  return {
    vote: ({ traceId, pseudo, value }) =>
      add(traceId, { feedbackSource: "user", feedbackType: "thumbs", value, feedbackUserId: pseudo }),
    comment: ({ traceId, pseudo, comment }) =>
      add(traceId, { feedbackSource: "user", feedbackType: "comment", value: comment, comment, feedbackUserId: pseudo }),
    forgetTraces: async (traceIds) => {
      if (traceIds.length === 0) return;
      const store = await mastra.getStorage()?.getStore("observability");
      const del = (store as { batchDeleteTraces?: (a: { traceIds: string[] }) => Promise<void> } | undefined)
        ?.batchDeleteTraces;
      if (del) await del.call(store, { traceIds });
    },
  };
}
