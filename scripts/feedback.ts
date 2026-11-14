/**
 * Votes 👍/👎 et commentaires enregistrés, lus directement dans la base (sans passer par le Studio),
 * regroupés par réponse, avec la question posée et la réponse donnée quand elles sont encore en
 * mémoire (MEMORY_DAYS jours, effacées par /oublier).
 *   pnpm feedback:prod                 tout ce qui a été reçu sur 30 jours
 *   pnpm feedback:prod --jours 7       sur 7 jours
 *   pnpm feedback:prod --negatifs      seulement les réponses avec un 👎 ou un commentaire
 *   pnpm feedback:prod --complet       réponses en entier (sinon tronquées)
 */
import { parseArgs } from "node:util";
import { mastra } from "../src/mastra/index.js";
import { botStore } from "../src/telegram/runtime.js";

const { values } = parseArgs({
  options: {
    jours: { type: "string", default: "30" },
    negatifs: { type: "boolean", default: false },
    complet: { type: "boolean", default: false },
  },
});

interface Feedback { timestamp: string | Date; traceId?: string; feedbackType: string; value: unknown }

const obs = (await mastra.getStorage()?.getStore("observability")) as any;
const start = new Date(Date.now() - Number(values.jours) * 86_400_000);
// Le stockage impose une pagination : on lit toutes les pages.
const feedback: Feedback[] = [];
for (let page = 0; ; page++) {
  const res = (await obs.listFeedback({
    filters: { timestamp: { start } },
    pagination: { page, perPage: 100 },
    orderBy: { field: "timestamp", direction: "ASC" },
  })) as { feedback: Feedback[] };
  feedback.push(...res.feedback);
  if (res.feedback.length < 100) break;
}

// Une réponse peut avoir plusieurs votes (avant le vote unique) et un commentaire.
const parTrace = new Map<string, Feedback[]>();
for (const f of feedback) {
  const key = f.traceId ?? "(sans trace)";
  parTrace.set(key, [...(parTrace.get(key) ?? []), f]);
}
const negatif = (fs: Feedback[]) => fs.some((f) => (f.feedbackType === "thumbs" && f.value === -1) || f.feedbackType === "comment");
const traces = [...parTrace].filter(([, fs]) => !values.negatifs || negatif(fs)).reverse(); // les plus récentes d'abord

const echanges = await botStore().exchanges(traces.map(([t]) => t));
const court = (s: string, n: number) => (values.complet || s.length <= n ? s : `${s.slice(0, n)}…`);
const indent = (s: string) => s.replace(/\n/g, "\n      ");
const date = (d: string | Date) => new Date(d).toLocaleString("fr-FR");

const pouces = feedback.filter((f) => f.feedbackType === "thumbs");
console.log(
  `${pouces.filter((f) => f.value === 1).length} 👍 · ${pouces.filter((f) => f.value === -1).length} 👎 · ` +
    `${feedback.filter((f) => f.feedbackType === "comment").length} commentaire(s) depuis le ${start.toLocaleDateString("fr-FR")}` +
    ` — ${traces.length} réponse(s) affichée(s)\n`,
);
for (const [traceId, fs] of traces) {
  const votes = fs.filter((f) => f.feedbackType === "thumbs").map((f) => (f.value === 1 ? "👍" : "👎")).join("");
  console.log(`── ${date(fs.at(-1)!.timestamp)}  ${votes}  trace ${traceId}`);
  const ex = echanges.get(traceId);
  if (ex) {
    console.log(`   Q : ${indent(court(ex.question, 300))}`);
    console.log(`   R : ${indent(court(ex.answer, 400))}`);
  } else {
    console.log("   (question et réponse plus en mémoire : délai dépassé ou /oublier)");
  }
  for (const c of fs.filter((f) => f.feedbackType === "comment")) console.log(`   💬 « ${c.value} »`);
  console.log();
}
process.exit(0);
