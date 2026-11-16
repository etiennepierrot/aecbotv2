/**
 * Modèle de langage simulé (spécification AI SDK v2) pour tester l'agent sans appel réseau.
 * `script` reçoit le prompt et renvoie soit un appel d'outil, soit du texte.
 */
export type FakeTurn = { tool: string; input: Record<string, unknown> } | { text: string };

export interface FakeModel {
  calls: { prompt: unknown[]; toolChoice?: unknown; maxOutputTokens?: number }[];
}

export function fakeModel(script: (prompt: any[], call: number) => FakeTurn): FakeModel & Record<string, unknown> {
  const calls: { prompt: unknown[]; toolChoice?: unknown; maxOutputTokens?: number }[] = [];
  const model = {
    specificationVersion: "v2",
    provider: "fake",
    modelId: "fake-model",
    supportedUrls: {},
    calls,
    async doGenerate(opts: { prompt: any[]; toolChoice?: unknown; maxOutputTokens?: number }) {
      calls.push({ prompt: opts.prompt, toolChoice: opts.toolChoice, maxOutputTokens: opts.maxOutputTokens });
      const turn = script(opts.prompt, calls.length);
      const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
      if ("tool" in turn) {
        return {
          content: [{ type: "tool-call", toolCallId: `call-${calls.length}`, toolName: turn.tool, input: JSON.stringify(turn.input) }],
          finishReason: "tool-calls", usage, warnings: [],
        };
      }
      return { content: [{ type: "text", text: turn.text }], finishReason: "stop", usage, warnings: [] };
    },
    async doStream(opts: { prompt: any[] }) {
      const { content, finishReason, usage } = (await model.doGenerate(opts)) as { content: any[]; finishReason: string; usage: unknown };
      const parts: unknown[] = [{ type: "stream-start", warnings: [] }];
      for (const c of content) {
        if (c.type === "text") parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: c.text }, { type: "text-end", id: "t" });
        else parts.push(c);
      }
      parts.push({ type: "finish", finishReason, usage });
      return { stream: new ReadableStream({ start(ctrl) { parts.forEach((p) => ctrl.enqueue(p)); ctrl.close(); } }) };
    },
  };
  return model;
}

/** Le texte que l'outil a renvoyé au modèle lors du dernier appel. */
export function lastToolOutput(prompt: any[]): string | undefined {
  const tool = [...prompt].reverse().find((m) => m.role === "tool");
  const part = tool?.content?.[0];
  return part?.output?.value ?? (part ? JSON.stringify(part.output) : undefined);
}
