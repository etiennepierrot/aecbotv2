import { afterEach, describe, expect, it } from "vitest";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import { NEON_EXPORTER_NAME, NeonStorageExporter } from "../src/mastra/storage-exporter.js";

/**
 * Sur Mastra Platform (MASTRA_DEPLOYMENT_ID défini), @mastra/observability retire en silence
 * MastraStorageExporter : les traces du bot n'arrivaient plus dans Neon.
 */
describe("exporteur Neon sur Mastra Platform", () => {
  const avant = process.env.MASTRA_DEPLOYMENT_ID;
  afterEach(() => {
    if (avant === undefined) delete process.env.MASTRA_DEPLOYMENT_ID;
    else process.env.MASTRA_DEPLOYMENT_ID = avant;
  });

  const exporteurs = (exporter: { name: string }) => {
    const obs = new Observability({
      configs: { default: { serviceName: "t", exporters: [exporter as never], logging: { enabled: false } } },
    });
    return obs.getDefaultInstance()!.getExporters().map((e) => e.name);
  };

  it("garde NeonStorageExporter, là où MastraStorageExporter est retiré", () => {
    process.env.MASTRA_DEPLOYMENT_ID = "dep_test";
    // Le constat : si Mastra cesse un jour de filtrer, ce test le dira, et l'enveloppe pourra partir.
    expect(exporteurs(new MastraStorageExporter())).toEqual([]);
    expect(exporteurs(new NeonStorageExporter())).toEqual([NEON_EXPORTER_NAME]);
  });

  it("délègue au vrai exporteur", async () => {
    const appels: string[] = [];
    const inner = new MastraStorageExporter();
    inner.onTracingEvent = async () => void appels.push("trace");
    inner.flush = async () => void appels.push("flush");
    const e = new NeonStorageExporter(inner);
    await e.onTracingEvent({} as never);
    await e.flush();
    expect(appels).toEqual(["trace", "flush"]);
  });
});
