import type { Mastra } from "@mastra/core";
import type {
  FeedbackEvent,
  InitExporterOptions,
  LogEvent,
  MetricEvent,
  ObservabilityExporter,
  ScoreEvent,
  TracingEvent,
} from "@mastra/core/observability";
import type { IMastraLogger } from "@mastra/core/logger";
import { MastraStorageExporter } from "@mastra/observability";

export const NEON_EXPORTER_NAME = "aec-neon-storage";

/**
 * Écrit les traces dans la base Neon (le stockage Mastra), y compris sur Mastra Platform.
 *
 * Sur la plateforme (`MASTRA_DEPLOYMENT_ID` défini), `@mastra/observability` retire sans erreur
 * tout `MastraStorageExporter` de la configuration (repéré par `instanceof` et par son nom) :
 * les traces ne partaient plus que vers Mastra Cloud, et Neon restait vide (pas de Studio,
 * pas de feedback relié, rien à effacer pour /oublier). En local, le même code écrivait bien.
 *
 * Cet enveloppeur n'est ni une instance ni un homonyme : il passe le filtre et délègue tout
 * au vrai exporteur (lots, reprises, stratégie d'écriture).
 */
export class NeonStorageExporter implements ObservabilityExporter {
  readonly name = NEON_EXPORTER_NAME;
  readonly inner: MastraStorageExporter;

  constructor(inner = new MastraStorageExporter()) {
    this.inner = inner;
  }

  init(options: InitExporterOptions): Promise<void> {
    return this.inner.init(options as never);
  }
  __setLogger(logger: IMastraLogger): void {
    this.inner.__setLogger(logger);
  }
  onTracingEvent(event: TracingEvent): void | Promise<void> {
    return this.inner.onTracingEvent(event);
  }
  exportTracingEvent(event: TracingEvent): Promise<void> {
    return this.inner.exportTracingEvent(event);
  }
  onLogEvent(event: LogEvent): Promise<void> {
    return this.inner.onLogEvent(event);
  }
  onMetricEvent(event: MetricEvent): Promise<void> {
    return this.inner.onMetricEvent(event);
  }
  onScoreEvent(event: ScoreEvent): Promise<void> {
    return this.inner.onScoreEvent(event);
  }
  onFeedbackEvent(event: FeedbackEvent): Promise<void> {
    return this.inner.onFeedbackEvent(event);
  }
  flush(): Promise<void> {
    return this.inner.flush();
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

/** Pour /status : l'exporteur vers Neon est-il réellement actif dans l'observabilité chargée ? */
export function neonExporterActive(mastra: Mastra): boolean {
  const instance = mastra.observability?.getDefaultInstance?.();
  return (instance?.getExporters?.() ?? []).some((e) => e.name === NEON_EXPORTER_NAME);
}
