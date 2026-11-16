/**
 * Éval de la recherche seule (sans LLM) sur les questions types qui ont des sources attendues.
 *   pnpm evals:recherche                  top 10, édition « toutes » : les réglages de l'outil de l'agent
 *   pnpm evals:recherche --topk 20        plus large (les quotas par édition changent avec topK)
 *   pnpm evals:recherche --only smic      quelques questions, avec le détail des premiers résultats
 *   pnpm evals:recherche --detail         le détail pour toutes les questions
 *
 * La requête est la question telle quelle ; l'agent, lui, la reformule en mots-clés.
 * Coût : un embedding par question. Le rapport complet est écrit dans evals/resultats/.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { EvalQuestion } from "../src/aec/evals.js";
import { evaluerRecherche, type ResultatRecherche } from "../src/aec/evals-recherche.js";
import { searchPassages } from "../src/aec/search.js";
import { pgVector } from "../src/corpus/deps.js";

const { values } = parseArgs({
  options: {
    topk: { type: "string", default: "10" },
    only: { type: "string", multiple: true },
    detail: { type: "boolean", default: false },
    concurrence: { type: "string", default: "4" },
  },
});

const topK = Number(values.topk);
if (!Number.isInteger(topK) || topK < 1) throw new Error(`--topk invalide : ${values.topk}`);

const all = JSON.parse(await readFile(new URL("../evals/questions.json", import.meta.url), "utf8")) as EvalQuestion[];
const questions = values.only?.length ? all.filter((q) => values.only!.includes(q.id)) : all;
const detail = values.detail || !!values.only?.length;

const f2 = (x: number | null) => (x === null ? "—   " : x.toFixed(2));
const onProgress = (r: ResultatRecherche) => {
  const etat = r.erreur
    ? "ERREUR"
    : r.attendu === "introuvable"
      ? "hors  "
      : r.rang === null
        ? "RATÉ  "
        : `rang ${String(r.rang).padEnd(2)}`;
  const couv = r.couverture === null ? "" : ` couverture ${Math.round(r.couverture * 100)} %`;
  console.log(`  ${etat} ${r.id.padEnd(24)} max ${f2(r.scoreMax)} pertinent ${f2(r.scorePertinent)}${couv}${r.erreur ? ` ${r.erreur}` : ""}`);
  if (detail) {
    for (const t of r.top) {
      console.log(`      ${t.pertinent ? "✓" : " "} ${t.rang}. ${t.score.toFixed(3)} ${t.titre}${t.page ? ` p. ${t.page}` : ""}`);
    }
  }
};

console.log(`▶ Recherche, top ${topK} — ${questions.length} questions`);
const rapport = await evaluerRecherche(questions, (requete) => searchPassages({ requete, topK, elargir: false }), {
  topK,
  concurrence: Number(values.concurrence) || 4,
  onProgress,
});

const pct = (x: number) => `${Math.round(x * 100)} %`;
console.log(`\nSur ${rapport.evaluees} questions avec sources attendues :`);
console.log(`  ${Object.entries(rapport.recall).map(([k, v]) => `recall@${k} ${pct(v)}`).join(" | ")}`);
console.log(`  MRR ${rapport.mrr.toFixed(2)} | couverture moyenne ${pct(rapport.couvertureMoyenne)}`);

const etendue = (xs: number[]) => {
  if (!xs.length) return "—";
  const s = [...xs].sort((a, b) => a - b);
  return `min ${s[0]!.toFixed(3)} · médiane ${s[Math.floor(s.length / 2)]!.toFixed(3)} · max ${s.at(-1)!.toFixed(3)}`;
};
console.log("\nMeilleur score par question (pour un éventuel seuil) :");
console.log(`  avec réponse  ${etendue(rapport.scoresMax.repondu)}`);
console.log(`  hors corpus   ${etendue(rapport.scoresMax.introuvable)}`);

await mkdir(new URL("../evals/resultats/", import.meta.url), { recursive: true });
const file = new URL(`../evals/resultats/recherche-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
await writeFile(file, JSON.stringify(rapport, null, 2));
console.log(`\nDétail : ${file.pathname}`);
await pgVector().pool.end();
process.exit(rapport.questions.some((r) => r.erreur) ? 1 : 0);
