import { BaseExporter, MastraStorageExporter } from "@mastra/observability";

type Inner = MastraStorageExporter;
type Arg<K extends keyof Inner> = Inner[K] extends (arg: infer A) => unknown ? A : never;

/**
 * Écrit les traces dans NOTRE base (Neon), y compris une fois déployé sur Mastra Cloud.
 *
 * Sur Mastra Cloud (`MASTRA_DEPLOYMENT_ID` défini), `@mastra/observability` retire sans bruit
 * tout `MastraStorageExporter` de la liste des exporteurs (test `instanceof` ou nom
 * « mastra-storage-exporter ») : la plateforme garde les traces chez elle. Résultat en production :
 * `repondre()` renvoyait bien un traceId, mais aucun span n'arrivait dans `mastra_span_events`
 * (Studio vide, votes sans trace, /oublier et purge sans objet).
 *
 * Cet exporteur n'est pas un `MastraStorageExporter` et porte un autre nom : il passe le filtre,
 * et délègue tout (tampon, lots, nouvelles tentatives) au vrai exporteur de stockage.
 */
export class NeonStorageExporter extends BaseExporter {
  name = "aec-neon-storage";
  readonly #inner: Inner;

  constructor(config: ConstructorParameters<typeof MastraStorageExporter>[0] = {}) {
    super(config);
    this.#inner = new MastraStorageExporter(config);
  }

  init(options: Arg<"init">) {
    return this.#inner.init(options);
  }

  override __setLogger(logger: Arg<"__setLogger">) {
    super.__setLogger(logger);
    this.#inner.__setLogger(logger);
  }

  override onTracingEvent(event: Arg<"onTracingEvent">) {
    return this.#inner.onTracingEvent(event);
  }

  protected async _exportTracingEvent(event: Arg<"exportTracingEvent">) {
    await this.#inner.exportTracingEvent(event);
  }

  onFeedbackEvent(event: Arg<"onFeedbackEvent">) {
    return this.#inner.onFeedbackEvent(event);
  }

  onLogEvent(event: Arg<"onLogEvent">) {
    return this.#inner.onLogEvent(event);
  }

  onMetricEvent(event: Arg<"onMetricEvent">) {
    return this.#inner.onMetricEvent(event);
  }

  onScoreEvent(event: Arg<"onScoreEvent">) {
    return this.#inner.onScoreEvent(event);
  }

  override flush() {
    return this.#inner.flush();
  }

  override shutdown() {
    return this.#inner.shutdown();
  }
}
