/**
 * Calibre SUITES_MIN_SCORE : score (meilleur passage) des questions d'évals dont on sait si le
 * corpus y répond, et propose un seuil qui sépare les deux groupes.
 *   pnpm suites:calibrer:prod
 *   pnpm suites:calibrer:prod "Que prévoit le programme pour les étudiants ?" "Et le nucléaire ?"
 */
import { readFile } from "node:fs/promises";
import { scoreQuestions } from "../src/aec/suites.js";
import { config } from "../src/config.js";

const libres = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (libres.length) {
  for (const s of await scoreQuestions(libres)) {
    const ok = s.score >= config().SUITES_MIN_SCORE ? "gardée " : "retirée";
    console.log(`${s.score.toFixed(3)}  ${ok}  ${s.question}`);
  }
  process.exit(0);
}

const questions = JSON.parse(await readFile("evals/questions.json", "utf8")) as { id: string; question: string; attendu: string }[];
const scores = await scoreQuestions(questions.map((q) => q.question));
const rows = questions.map((q, i) => ({ ...q, score: scores[i]!.score })).sort((a, b) => b.score - a.score);
for (const r of rows) console.log(`${r.score.toFixed(3)}  ${r.attendu.padEnd(11)}  ${r.id}`);

const repondu = rows.filter((r) => r.attendu === "repondu").map((r) => r.score);
const introuvable = rows.filter((r) => r.attendu === "introuvable").map((r) => r.score);
const bas = Math.min(...repondu);
const haut = Math.max(...introuvable);
console.log(`\nRépondues : de ${bas.toFixed(3)} à ${Math.max(...repondu).toFixed(3)}`);
console.log(`Introuvables : de ${Math.min(...introuvable).toFixed(3)} à ${haut.toFixed(3)}`);
console.log(`Seuil actuel (SUITES_MIN_SCORE) : ${config().SUITES_MIN_SCORE}`);
if (bas > haut) {
  console.log(`Seuil proposé : ${((bas + haut) / 2).toFixed(2)} (sépare les deux groupes)`);
} else {
  console.log(
    `Les groupes se chevauchent : un seuil autour de ${haut.toFixed(2)} écarte toutes les introuvables ` +
      `mais aussi ${repondu.filter((s) => s < haut).length} question(s) répondue(s). Préférer la prudence.`,
  );
}
process.exit(0);
