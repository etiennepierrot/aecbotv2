/**
 * Grille de décision de la consolidation, sur evals/consolidation.json (captures annotées à la main).
 *   pnpm evals:consolidation                                   modèle par défaut, une passe
 *   pnpm evals:consolidation --passes 3                        + stabilité (force, émetteur)
 *   pnpm evals:consolidation --model mistral/mistral-small-latest --model mistral/mistral-medium-latest
 * Les référentiels et la recherche dans le programme viennent de la base de .env. Rien n'est écrit
 * dans les tables de l'argumentaire.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { searchPassages } from "../src/aec/search.js";
import { CONSOLIDATION_MODEL, creerAnalyseur, type Compteur, type ReferentielsActifs } from "../src/argu/analyse.js";
import { arguStore } from "../src/argu/deps.js";
import { type EvalCapture, passer, type Passe, resumer } from "../src/argu/evals.js";
import { assertModelKey } from "../src/config.js";
import { CATEGORIES_PROGRAMME } from "../src/corpus/types.js";

const { values } = parseArgs({
  options: {
    model: { type: "string", multiple: true },
    passes: { type: "string", default: "1" },
    jeu: { type: "string", default: "evals/consolidation.json" },
  },
});
type Prix = { entree: number | null; sortie: number | null };
const prixTable = JSON.parse(await readFile(new URL("../evals/prix.json", import.meta.url), "utf8")) as Record<string, Prix>;
const jeu = JSON.parse(await readFile(values.jeu!, "utf8")) as { _note?: string; captures: EvalCapture[] };
const nbPasses = Math.max(1, Number(values.passes) || 1);
const models = values.model?.length ? values.model : [CONSOLIDATION_MODEL()];
for (const m of models) assertModelKey(m);

const store = arguStore();
const [categories, themes, registres, classes, familles, publics] = await Promise.all(
  ["categorie", "theme", "registre", "classe_sociale", "famille", "public"].map((t) => store.referentiel(t)),
);
const r: ReferentielsActifs = { categories: categories!, themes: themes!, registres: registres!, classes: classes!, familles: familles!, publics: publics! };
const rechercher = (requete: string) => searchPassages({ requete, categories: CATEGORIES_PROGRAMME, elargir: false, topK: 5 });

if (jeu._note) console.log(jeu._note);
let echec = false;
for (const model of models) {
  console.log(`\n▶ ${model} — ${jeu.captures.length} captures × ${nbPasses} passe(s)`);
  const compteur: Compteur = { inputTokens: 0, outputTokens: 0 };
  const analyseur = creerAnalyseur(model, compteur);
  const passes: Passe[][] = [];
  for (const item of jeu.captures) {
    const lesPasses: Passe[] = [];
    for (let i = 0; i < nbPasses; i++) lesPasses.push(await passer(item, analyseur, r, rechercher));
    passes.push(lesPasses);
    const p = lesPasses[0]!;
    console.log(`  ${item.id.padEnd(12)} ${p.affirmations.length} affirmation(s), ${p.citationsIntrouvables} citation(s) introuvable(s) · émetteur ${p.emetteur.classe_sociale} / ${p.emetteur.orientation}`);
  }
  const rapport = resumer(jeu.captures, passes);
  for (const v of rapport.verdict) console.log(`  ${v.ok ? "✓" : "✗"} ${v.critere.padEnd(26)} ${v.valeur.padEnd(10)} (seuil ${v.seuil})`);
  console.log(`  Citations du modèle retrouvées mot pour mot : ${Math.round(rapport.citationsRetrouvees * 100)} % (les autres sont écartées par le code)`);
  console.log(`  Affirmations inventées (sans équivalent annoté) : ${rapport.inventees}`);
  console.log(`  fake_news proposés sans preuve, retirés par la règle : ${rapport.fakeNewsSansPreuveBrut}`);
  console.log(`  Traits de l'émetteur « indetermine » : ${Math.round(rapport.tauxIndetermine * 100)} %`);
  const prix = prixTable[model];
  const cout = prix?.entree != null && prix?.sortie != null
    ? (compteur.inputTokens * prix.entree + compteur.outputTokens * prix.sortie) / 1_000_000 / (jeu.captures.length * nbPasses)
    : null;
  console.log(`  Jetons : ${compteur.inputTokens} en entrée, ${compteur.outputTokens} en sortie${cout !== null ? ` · ${cout.toFixed(4)} $ par capture` : " (prix inconnu dans evals/prix.json)"}`);
  if (rapport.verdict.some((v) => !v.ok)) echec = true;
}
process.exit(echec ? 2 : 0);
