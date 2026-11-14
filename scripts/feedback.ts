/**
 * Derniers avis 👍/👎 enregistrés, lus directement dans la base (sans passer par le Studio).
 *   pnpm feedback:prod            les 20 derniers avis de la production
 *   pnpm feedback:prod --jours 7  ceux des 7 derniers jours
 */
import { parseArgs } from "node:util";
import { mastra } from "../src/mastra/index.js";

const { values } = parseArgs({ options: { jours: { type: "string", default: "30" } } });
const obs = (await mastra.getStorage()?.getStore("observability")) as any;
const start = new Date(Date.now() - Number(values.jours) * 86_400_000);
const { feedback } = await obs.listFeedback({
  filters: { timestamp: { start } },
  pagination: { page: 0, perPage: 20 },
  orderBy: { field: "timestamp", direction: "DESC" },
});
console.log(`${feedback.length} avis depuis le ${start.toLocaleDateString("fr-FR")}`);
for (const f of feedback) {
  const v = f.feedbackType === "thumbs" ? (f.value === 1 ? "👍" : "👎") : `« ${String(f.value).slice(0, 80)} »`;
  console.log(`${new Date(f.timestamp).toLocaleString("fr-FR")}  ${v}  trace ${f.traceId}  span ${f.spanId ?? "-"}`);
}
const { traces } = await obs.listTraces({ pagination: { page: 0, perPage: 3 } }).catch(() => ({ traces: [] }));
console.log(`\nDernières traces en base : ${(traces ?? []).map((t: any) => t.traceId).join(", ") || "aucune"}`);
process.exit(0);
