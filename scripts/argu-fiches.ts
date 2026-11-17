/**
 * Importe des fiches d'objections en brouillon dans aec_objections, pour relecture par l'équipe.
 *   pnpm argu:fiches:prod                                  argu/fiches-brouillon.json
 *   pnpm argu:fiches:prod --fichier autres-fiches.json     un autre fichier
 *   pnpm argu:fiches:prod --verifier                       valide le fichier sans rien écrire
 * Une objection qui a déjà le même intitulé n'est jamais modifiée, quel que soit son statut.
 * (`pnpm argu:fiches …` fait la même chose sur la base locale de .env)
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { arguStore } from "../src/argu/deps.js";
import { importerFiches, lireFiches } from "../src/argu/fiches.js";

const { values } = parseArgs({
  options: {
    fichier: { type: "string", default: "argu/fiches-brouillon.json" },
    verifier: { type: "boolean", default: false },
  },
});

const fiches = lireFiches(JSON.parse(await readFile(values.fichier!, "utf8")));
console.log(`${fiches.length} fiches lues dans ${values.fichier}`);
if (values.verifier) process.exit(0);

const { ajoutees, existantes } = await importerFiches(arguStore(), fiches);
for (const i of ajoutees) console.log(`  + ${i}`);
for (const i of existantes) console.log(`  = ${i} (déjà là, laissée telle quelle)`);
console.log(`${ajoutees.length} ajoutée(s) en brouillon, ${existantes.length} déjà présente(s).`);
process.exit(0);
