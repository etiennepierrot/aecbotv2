/**
 * Passe les questions types à un ou plusieurs modèles et applique la grille de décision.
 *   pnpm evals                                           modèle par défaut (AEC_MODEL)
 *   pnpm evals --model mistral/mistral-small-latest --model openai/gpt-5-mini
 *   pnpm evals --sans-juge                               sans le juge de fidélité (gratuit hors modèle)
 *   pnpm evals --only smic --only otan                   quelques questions (passe locale, non enregistrée)
 *   pnpm evals --local                                   sans enregistrer d'experiment en base
 *
 * Par défaut, chaque modèle donne un experiment Mastra sur le dataset « Questions types »
 * (synchronisé depuis evals/questions.json) : réponses, scores et traces restent en base,
 * consultables et comparables dans Studio (pnpm dev → Datasets).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { mastra } from "../src/mastra/index.js";
import { runEvalSuite, SEUILS, type EvalQuestion, type EvalReport, type Prix, type QuestionResult } from "../src/aec/evals.js";
import { ecartsEntreExperiments, runModelExperiment, syncQuestionsDataset } from "../src/aec/experiments.js";
import { DEFAULT_MODEL } from "../src/mastra/agents/aec.js";
import { pgVector } from "../src/corpus/deps.js";
import { assertModelKey } from "../src/config.js";
import { DEFAULT_JUDGE_MODEL } from "../src/mastra/scorers/index.js";

const { values } = parseArgs({
  options: {
    model: { type: "string", multiple: true },
    only: { type: "string", multiple: true },
    "sans-juge": { type: "boolean", default: false },
    local: { type: "boolean", default: false },
    concurrence: { type: "string", default: "3" },
  },
});

const all = JSON.parse(await readFile(new URL("../evals/questions.json", import.meta.url), "utf8")) as EvalQuestion[];
const questions = values.only?.length ? all.filter((q) => values.only!.includes(q.id)) : all;
const prixTable = JSON.parse(await readFile(new URL("../evals/prix.json", import.meta.url), "utf8")) as Record<string, Prix>;
const models = values.model?.length ? values.model : [DEFAULT_MODEL];

for (const m of models) assertModelKey(m);
if (!values["sans-juge"]) assertModelKey(DEFAULT_JUDGE_MODEL);

const onProgress = (r: QuestionResult) => {
  const ok = r.erreur ? "ERREUR" : r.scores.statut === 1 ? "ok    " : "RATÉ  ";
  const fid = r.scores.fidelite !== undefined ? ` fidélité ${r.scores.fidelite.toFixed(2)}` : "";
  const rej = r.citationsRejetees ? ` ${r.citationsRejetees} citation(s) rejetée(s)` : "";
  console.log(`  ${ok} ${r.id.padEnd(20)} ${r.statut ?? ""}${fid}${rej}${r.erreur ? ` ${r.erreur}` : ""}`);
};

// --only ne porte que sur quelques questions : un experiment partiel fausserait les comparaisons.
const enregistre = !values.local && !values.only?.length;
const reports: EvalReport[] = [];
const experimentIds: string[] = [];
const dataset = enregistre ? await syncQuestionsDataset(mastra, all) : null;
if (dataset) {
  const { ajoutees, modifiees, retirees } = dataset;
  if (ajoutees + modifiees + retirees) console.log(`Dataset mis à jour : +${ajoutees} ~${modifiees} -${retirees}`);
}

for (const model of models) {
  console.log(`\n▶ ${model} — ${questions.length} questions`);
  const common = { model, prix: prixTable[model], juge: !values["sans-juge"], onProgress };
  if (dataset) {
    const { experimentId, report } = await runModelExperiment({
      ...common,
      dataset: dataset.dataset,
      maxConcurrency: Number(values.concurrence) || 3,
    });
    console.log(`  experiment ${experimentId}`);
    experimentIds.push(experimentId);
    reports.push(report);
  } else {
    reports.push(await runEvalSuite({ ...common, questions }));
  }
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
      r.passe ? "PASSE" : g.erreurs ? `échoue (${g.erreurs} erreur${g.erreurs > 1 ? "s" : ""})` : "échoue",
    ].join(" | "),
  );
}

const passing = reports.filter((r) => r.passe && r.grille.coutParQuestionUsd !== null);
if (passing.length) {
  const best = passing.sort((a, b) => a.grille.coutParQuestionUsd! - b.grille.coutParQuestionUsd!)[0]!;
  console.log(`\n→ Le moins cher qui passe les seuils : ${best.model}`);
}

if (dataset && experimentIds.length >= 2) {
  const ecarts = await ecartsEntreExperiments(mastra, dataset.dataset, experimentIds);
  console.log(`\nQuestions où les modèles diffèrent de ${models[0]} : ${ecarts.length}`);
  for (const e of ecarts) {
    const cells = experimentIds.map((id, i) => {
      const v = e.parExperiment[id];
      const fid = v?.fidelite == null ? "" : ` fid ${v.fidelite.toFixed(2)}`;
      return `${models[i]} : ${v ? (v.statut === 1 ? "ok" : "raté") + fid : "—"}`;
    });
    console.log(`  ${e.qid.padEnd(20)} ${cells.join(" | ")}`);
  }
  console.log("Détail côte à côte : pnpm dev → Datasets → Questions types → Experiments → Compare.");
}

await mkdir(new URL("../evals/resultats/", import.meta.url), { recursive: true });
const file = new URL(`../evals/resultats/${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
await writeFile(file, JSON.stringify(reports, null, 2));
console.log(`\nDétail : ${file.pathname}`);
await pgVector().pool.end();
process.exit(0);
