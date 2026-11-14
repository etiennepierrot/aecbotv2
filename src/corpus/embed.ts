export interface Embedder {
  readonly dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbedderConfig {
  /** Base d'une API d'embeddings au format OpenAI (POST {baseUrl}/embeddings). */
  baseUrl: string;
  apiKey: string;
  model: string;
  dimension?: number;
  label?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Embeddings `mistral-embed` (1024 dimensions), via l'API Mistral ou via OpenRouter :
 * même modèle, mêmes vecteurs, donc le même index sert dans les deux cas. Les questions
 * des militants passent aussi par ici.
 */
export class OpenAICompatibleEmbedder implements Embedder {
  readonly dimension: number;
  private readonly batchSize = 32;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: EmbedderConfig) {
    this.dimension = cfg.dimension ?? 1024;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      out.push(...(await this.embedBatch(texts.slice(i, i + this.batchSize))));
    }
    return out;
  }

  private async embedBatch(input: string[], attempt = 1): Promise<number[][]> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.cfg.model, input }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return this.embedBatch(input, attempt + 1);
    }
    if (!res.ok) throw new Error(`Embeddings ${this.cfg.label ?? ""} : HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    const vectors = body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (vectors.length !== input.length || vectors.some((v) => v.length !== this.dimension)) {
      throw new Error(`Embeddings ${this.cfg.label ?? ""} : réponse inattendue (${vectors.length} vecteurs)`);
    }
    return vectors;
  }
}

/** Mistral en direct si MISTRAL_API_KEY est fourni, sinon OpenRouter (même modèle). */
export function embedderFromKeys(keys: { mistral?: string; openrouter?: string }): Embedder {
  if (keys.mistral) {
    return new OpenAICompatibleEmbedder({
      baseUrl: "https://api.mistral.ai/v1", apiKey: keys.mistral, model: "mistral-embed", label: "Mistral",
    });
  }
  if (keys.openrouter) {
    return new OpenAICompatibleEmbedder({
      baseUrl: "https://openrouter.ai/api/v1", apiKey: keys.openrouter, model: "mistralai/mistral-embed-2312",
      label: "OpenRouter",
    });
  }
  throw new Error("Ni MISTRAL_API_KEY ni OPENROUTER_API_KEY : impossible de calculer les embeddings");
}
