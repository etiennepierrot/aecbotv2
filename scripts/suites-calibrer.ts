/**
 * Calibre SUITES_MIN_SCORE : score (meilleur passage) de questions dont on sait si le corpus y
 * répond, et propose un seuil.
 *   pnpm suites:calibrer:prod                                  evals/suites.json, sinon evals/questions.json
 *   pnpm suites:calibrer:prod --fichier evals/questions.json   un autre jeu
 *   pnpm suites:calibrer:prod --detail                         le score de chaque question
 *   pnpm suites:calibrer:prod "Que prévoit le programme pour les étudiants ?" "Et le nucléaire ?"
 * Construire evals/suites.json : pnpm suites:donnees:prod.
 */
import { access, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { scoreQuestions } from "../src/aec/suites.js";
import { tableauSeuils, type SuiteDonnee } from "../src/aec/suites-donnees.js";
import { config } from "../src/config.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { fichier: { type: "string" }, detail: { type: "boolean", default: false } },
});
const seuilActuel = config().SUITES_MIN_SCORE;

if (positionals.length) {
  for (const s of await scoreQuestions(positionals)) {
    const ok = s.score >= seuilActuel ? "gardée " : "retirée";
    console.log(`${s.score.toFixed(3)}  ${ok}  ${s.question}`);
  }
  process.exit(0);
}

const fichier = values.fichier ?? (await access("evals/suites.json").then(() => "evals/suites.json", () => "evals/questions.json"));
const toutes = JSON.parse(await readFile(fichier, "utf8")) as (Pick<SuiteDonnee, "id" | "question" | "attendu"> & Partial<SuiteDonnee>)[];
// Seules les étiquettes sûres comptent : ni « partiel », ni une entrée encore à relire.
const questions = toutes.filter((q) => (q.attendu === "repondu" || q.attendu === "introuvable") && !q.aRelire);
const ecartees = toutes.length - questions.length;
console.log(`${fichier} : ${questions.length} question(s)${ecartees ? `, ${ecartees} écartée(s) (partiel ou à relire)` : ""}\n`);

const scores = await scoreQuestions(questions.map((q) => q.question));
const rows = questions.map((q, i) => ({ ...q, score: scores[i]!.score })).sort((a, b) => b.score - a.score);
if (values.detail || rows.length <= 40) {
  for (const r of rows) console.log(`${r.score.toFixed(3)}  ${r.attendu.padEnd(11)}  ${(r.origine ?? "").padEnd(7)}  ${r.id}`);
  console.log();
}

const repondu = rows.filter((r) => r.attendu === "repondu").map((r) => r.score);
const introuvable = rows.filter((r) => r.attendu === "introuvable").map((r) => r.score);
if (!repondu.length || !introuvable.length) {
  console.log("Il faut des questions des deux groupes (repondu et introuvable) pour calibrer.");
  process.exit(1);
}
console.log(`Répondues (${repondu.length}) : de ${Math.min(...repondu).toFixed(3)} à ${Math.max(...repondu).toFixed(3)}`);
console.log(`Introuvables (${introuvable.length}) : de ${Math.min(...introuvable).toFixed(3)} à ${Math.max(...introuvable).toFixed(3)}\n`);

// Le tableau, de 0,70 au premier seuil sans faux positif (au-delà, on ne fait que retirer de bonnes suites).
const lignes = tableauSeuils(repondu, introuvable);
const pct = (n: number, d: number) => `${n}/${d} (${Math.round((100 * n) / d)} %)`;
const sansFaux = lignes.find((l) => l.fauxPositifs === 0)!;
const grille = [...new Set([...lignes.filter((l) => l.seuil >= 0.7 && l.seuil <= sansFaux.seuil).map((l) => Math.round(l.seuil * 100) / 100), seuilActuel, sansFaux.seuil])]
  .sort((a, b) => a - b);
console.log("seuil  | introuvables proposées à tort | bonnes suites retirées");
for (const seuil of grille) {
  const fp = introuvable.filter((s) => s >= seuil).length;
  const ret = repondu.filter((s) => s < seuil).length;
  const marque = seuil === seuilActuel ? "  ← actuel" : seuil === sansFaux.seuil ? "  ← premier seuil sans faux positif" : "";
  console.log(`${seuil.toFixed(3)}  | ${pct(fp, introuvable.length).padEnd(29)} | ${pct(ret, repondu.length)}${marque}`);
}
console.log(
  `\nRègle du bot : mieux vaut ne rien proposer qu'une question sans réponse. Le seuil ${sansFaux.seuil.toFixed(3)} ` +
    `n'en laisse passer aucune et retire ${pct(sansFaux.retirees, repondu.length)} des bonnes suites.`,
);
process.exit(0);
