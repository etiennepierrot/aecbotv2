import { describe, expect, it } from "vitest";
import { assertModelKey, defaultModels } from "../src/config.js";
import { embedderFromKeys, OpenAICompatibleEmbedder } from "../src/corpus/embed.js";

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
  it("OpenRouter : bon point d'accès, bon modèle, ordre respecté, lots de 32", async () => {
    const api = fakeApi();
    const e = new OpenAICompatibleEmbedder({
      baseUrl: "https://openrouter.ai/api/v1/", apiKey: "sk-or", model: "mistralai/mistral-embed-2312", fetchImpl: api.fetchImpl,
    });
    const v = await e.embed(Array.from({ length: 40 }, (_, i) => `t${i}`));
    expect(api.calls.map((c) => [c.url, c.body.model, c.body.input.length, c.auth])).toEqual([
      ["https://openrouter.ai/api/v1/embeddings", "mistralai/mistral-embed-2312", 32, "Bearer sk-or"],
      ["https://openrouter.ai/api/v1/embeddings", "mistralai/mistral-embed-2312", 8, "Bearer sk-or"],
    ]);
    expect(v.map((x) => x[0])).toEqual([...Array(32).keys(), ...Array(8).keys()]);
  });

  it("refuse des vecteurs de la mauvaise dimension (mauvais modèle)", async () => {
    const api = fakeApi(1536);
    const e = new OpenAICompatibleEmbedder({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetchImpl: api.fetchImpl });
    await expect(e.embed(["a"])).rejects.toThrow(/réponse inattendue/);
  });

  it("Mistral en direct si sa clé est là, sinon OpenRouter", () => {
    expect(() => embedderFromKeys({})).toThrow(/OPENROUTER_API_KEY/);
    expect(embedderFromKeys({ openrouter: "k" }).dimension).toBe(1024);
    expect(defaultModels({ OPENROUTER_API_KEY: "k" })).toEqual({
      answer: "openrouter/mistralai/mistral-small-2603", judge: "openrouter/mistralai/mistral-medium-3-5",
    });
    expect(defaultModels({ MISTRAL_API_KEY: "k", OPENROUTER_API_KEY: "k" }).answer).toBe("mistral/mistral-small-latest");
  });

  it("signale clairement un modèle dont la clé manque", () => {
    expect(() => assertModelKey("mistral/mistral-small-latest", { OPENROUTER_API_KEY: "k" })).toThrow(/MISTRAL_API_KEY, absente/);
    expect(() => assertModelKey("openrouter/mistralai/mistral-small-2603", { OPENROUTER_API_KEY: "k" })).not.toThrow();
  });
});
