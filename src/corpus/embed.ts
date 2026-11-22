export interface Embedder {
  readonly dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Embeddings `mistral-embed` (1024 dimensions) par l'API Mistral. Les questions des militants
 * passent aussi par ici. Le routeur d'embeddings de Mastra ne connaît pas Mistral : d'où cet appel direct.
 */
export class MistralEmbedder implements Embedder {
  readonly dimension = 1024;
  private readonly url = "https://api.mistral.ai/v1/embeddings";
  private readonly model = "mistral-embed";
  private readonly batchSize = 32;

  /** `fetchImpl` : remplaçable en test. */
  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!apiKey?.trim()) throw new Error("MISTRAL_API_KEY manquante : impossible de calculer les embeddings");
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      out.push(...(await this.embedBatch(texts.slice(i, i + this.batchSize))));
    }
    return out;
  }

  private async embedBatch(input: string[], attempt = 1): Promise<number[][]> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return this.embedBatch(input, attempt + 1);
    }
    if (!res.ok) throw new Error(`Embeddings Mistral : HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    const vectors = body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (vectors.length !== input.length || vectors.some((v) => v.length !== this.dimension)) {
      throw new Error(`Embeddings Mistral : réponse inattendue (${vectors.length} vecteurs)`);
    }
    return vectors;
  }
}
