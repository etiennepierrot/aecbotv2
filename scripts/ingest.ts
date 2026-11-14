/**
 * Lance le workflow d'ingestion depuis la ligne de commande.
 *   pnpm ingest                 scan des documents nouveaux ou modifiés
 *   pnpm ingest --force         tout réindexer
 *   pnpm ingest --limit 3       essai sur 3 documents
 */
import { parseArgs } from "node:util";
import { mastra } from "../src/mastra/index.js";

const { values } = parseArgs({
  options: {
    force: { type: "boolean", default: false },
    limit: { type: "string" },
    "allow-mass-removal": { type: "boolean", default: false },
  },
});

const run = await mastra.getWorkflow("ingest").createRun();
const result = await run.start({
  inputData: {
    mode: "scan",
    force: values.force ?? false,
    limit: values.limit ? Number(values.limit) : undefined,
    allowMassRemoval: values["allow-mass-removal"] ?? false,
  },
});

if (result.status !== "success") {
  const err = result.status === "failed" ? result.error : undefined;
  console.error("Échec de l'ingestion :", (err as { message?: string } | undefined)?.message ?? result.status);
  process.exit(1);
}

const r = result.result;
for (const d of r.documents) {
  console.log(`${d.status.padEnd(7)} ${d.id.padEnd(16)} ${String(d.passages).padStart(4)} passages  ${d.title}${d.detail ? `  (${d.detail})` : ""}`);
}
console.log(
  `\n${r.indexed} indexés · ${r.excluded} écartés · ${r.errors} erreurs · ${r.unchanged} inchangés · ${r.removed.length} retirés`,
);
for (const w of r.warnings) console.warn(`⚠ ${w}`);
process.exit(r.errors > 0 ? 2 : 0);
