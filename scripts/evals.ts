/**
 * Passe les questions types à un ou plusieurs modèles et applique la grille de décision.
 *   pnpm evals                                           modèle par défaut (AEC_MODEL)
 *   pnpm evals --model mistral/mistral-small-latest --model openai/gpt-5-mini
 *   pnpm evals --sans-juge                               sans le juge de fidélité (gratuit hors modèle)
 *   pnpm evals --only smic --only otan                   quelques questions
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import "../src/mastra/index.js";
import { runEvalSuite, SEUILS, type EvalQuestion, type EvalReport, type Prix } from "../src/aec/evals.js";
import { DEFAULT_MODEL } from "../src/mastra/agents/aec.js";
import { pgVector } from "../src/corpus/deps.js";
import { assertModelKey } from "../src/config.js";
import { DEFAULT_JUDGE_MODEL } from "../src/mastra/scorers/index.js";

const { values } = parseArgs({
  options: {
    model: { type: "string", multiple: true },
    only: { type: "string", multiple: true },
    "sans-juge": { type: "boolean", default: false },
  },
});

const all = JSON.parse(await readFile(new URL("../evals/questions.json", import.meta.url), "utf8")) as EvalQuestion[];
const questions = values.only?.length ? all.filter((q) => values.only!.includes(q.id)) : all;
const prixTable = JSON.parse(await readFile(new URL("../evals/prix.json", import.meta.url), "utf8")) as Record<string, Prix>;
const models = values.model?.length ? values.model : [DEFAULT_MODEL];

for (const m of models) assertModelKey(m);
if (!values["sans-juge"]) assertModelKey(DEFAULT_JUDGE_MODEL);

const reports: EvalReport[] = [];
for (const model of models) {
  console.log(`\n▶ ${model} — ${questions.length} questions`);
  const report = await runEvalSuite({
    questions,
    model,
    prix: prixTable[model],
    juge: !values["sans-juge"],
    onProgress: (r) => {
      const ok = r.erreur ? "ERREUR" : r.scores.statut === 1 ? "ok    " : "RATÉ  ";
      const fid = r.scores.fidelite !== undefined ? ` fidélité ${r.scores.fidelite.toFixed(2)}` : "";
      const rej = r.citationsRejetees ? ` ${r.citationsRejetees} citation(s) rejetée(s)` : "";
      console.log(`  ${ok} ${r.id.padEnd(20)} ${r.statut ?? ""}${fid}${rej}${r.erreur ? ` ${r.erreur}` : ""}`);
    },
  });
  reports.push(report);
}

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)} %`);
console.log("\nGrille de décision");
console.log(
  ["modèle".padEnd(32), "citations rejetées", "hors corpus", "fidélité", "bon statut", "source attendue", "coût / question", "verdict"].join(" | "),
);
for (const r of reports) {
  const g = r.grille;
  console.log(
    [
      r.model.padEnd(32),
      `${g.citationsRejetees} (seuil ${SEUILS.citationsRejetees})`.padEnd(18),
      `${pct(g.horsCorpusIntrouvable)}`.padEnd(11),
      (g.fideliteMoyenne === null ? "—" : g.fideliteMoyenne.toFixed(2)).padEnd(8),
      pct(g.statutCorrect).padEnd(10),
      pct(g.sourceAttendue).padEnd(15),
      (g.coutParQuestionUsd === null
        ? `${g.jetonsMoyens.entree}+${g.jetonsMoyens.sortie} jetons`
        : `${(g.coutParQuestionUsd * 100).toFixed(2)} ¢`
      ).padEnd(15),
      r.passe ? "PASSE" : "échoue",
    ].join(" | "),
  );
}

const passing = reports.filter((r) => r.passe && r.grille.coutParQuestionUsd !== null);
if (passing.length) {
  const best = passing.sort((a, b) => a.grille.coutParQuestionUsd! - b.grille.coutParQuestionUsd!)[0]!;
  console.log(`\n→ Le moins cher qui passe les seuils : ${best.model}`);
}

await mkdir(new URL("../evals/resultats/", import.meta.url), { recursive: true });
const file = new URL(`../evals/resultats/${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
await writeFile(file, JSON.stringify(reports, null, 2));
console.log(`\nDétail : ${file.pathname}`);
await pgVector().pool.end();
