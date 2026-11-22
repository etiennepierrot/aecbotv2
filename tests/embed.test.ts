import { describe, expect, it } from "vitest";
import { assertModelKey, DEFAULT_MODELS } from "../src/config.js";
import { mistralEmbedder, OpenAICompatibleEmbedder } from "../src/corpus/embed.js";

function fakeApi(dimension = 1024) {
  const calls: { url: string; body: any; auth: string | null }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body, auth: new Headers(init.headers).get("authorization") });
    // Réponse dans le désordre : l'ordre doit venir de `index`.
    const data = body.input.map((_: string, i: number) => ({ index: i, embedding: Array(dimension).fill(i) })).reverse();
    return new Response(JSON.stringify({ object: "list", data }));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("embeddings", () => {
  it("bon point d'accès, bon modèle, ordre respecté, lots de 32", async () => {
    const api = fakeApi();
    const e = new OpenAICompatibleEmbedder({
      baseUrl: "https://api.mistral.ai/v1/", apiKey: "sk-m", model: "mistral-embed", fetchImpl: api.fetchImpl,
    });
    const v = await e.embed(Array.from({ length: 40 }, (_, i) => `t${i}`));
    expect(api.calls.map((c) => [c.url, c.body.model, c.body.input.length, c.auth])).toEqual([
      ["https://api.mistral.ai/v1/embeddings", "mistral-embed", 32, "Bearer sk-m"],
      ["https://api.mistral.ai/v1/embeddings", "mistral-embed", 8, "Bearer sk-m"],
    ]);
    expect(v.map((x) => x[0])).toEqual([...Array(32).keys(), ...Array(8).keys()]);
  });

  it("refuse des vecteurs de la mauvaise dimension (mauvais modèle)", async () => {
    const api = fakeApi(1536);
    const e = new OpenAICompatibleEmbedder({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetchImpl: api.fetchImpl });
    await expect(e.embed(["a"])).rejects.toThrow(/réponse inattendue/);
  });

  it("Mistral par défaut, et une clé obligatoire pour les embeddings", () => {
    expect(() => mistralEmbedder(undefined)).toThrow(/MISTRAL_API_KEY manquante/);
    expect(() => mistralEmbedder("  ")).toThrow(/MISTRAL_API_KEY manquante/);
    expect(mistralEmbedder("k").dimension).toBe(1024);
    expect(DEFAULT_MODELS).toEqual({ answer: "mistral/mistral-small-latest", judge: "mistral/mistral-medium-latest" });
  });

  it("signale clairement un modèle dont la clé manque", () => {
    expect(() => assertModelKey("mistral/mistral-small-latest", { OPENAI_API_KEY: "k" })).toThrow(/MISTRAL_API_KEY, absente/);
    expect(() => assertModelKey("mistral/mistral-small-latest", {})).toThrow(/modèle par défaut.*Clés présentes : aucune/);
    expect(() => assertModelKey("mistral/x", { AEC_MODEL: "mistral/x", OPENAI_API_KEY: "k" })).toThrow(
      /imposé par AEC_MODEL.*Clés présentes : OPENAI_API_KEY/,
    );
    expect(() => assertModelKey("mistral/mistral-small-latest", { MISTRAL_API_KEY: "k" })).not.toThrow();
  });
});
