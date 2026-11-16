/**
 * Construit evals/suites.json, le jeu de données du calibrage de SUITES_MIN_SCORE.
 *   pnpm suites:donnees:prod                         les trois sources, valeurs par défaut
 *   pnpm suites:donnees:prod --reelles --jours 30    seulement les suites proposées en production
 *   pnpm suites:donnees:prod --rejouer               rejoue les questions récentes avec le prompt actuel
 *                                                    (sans lire les traces : pour mesurer un changement de prompt)
 *   pnpm suites:donnees:prod --passages 50           seulement des questions écrites depuis des passages
 *   pnpm suites:donnees:prod --voisines 50           seulement des questions voisines, a priori sans réponse
 *
 * 1. reelles   : les suites que le modèle a proposées en production, AVANT filtrage (lues dans les traces ;
 *               sans trace en base, les questions encore dans aec_conversations sont rejouées).
 * 2. passages  : des passages tirés au hasard ; un LLM écrit une question à laquelle le passage répond.
 * 3. voisines  : un LLM écrit des questions proches d'un thème du programme mais qu'il ne traite pas.
 * Puis un juge LLM lit les 8 meilleurs passages de chaque question : repondu, partiel ou introuvable.
 * Les désaccords avec l'étiquette prévue et les « partiel » sont marqués aRelire : à trancher à la main
 * (corriger « attendu », puis aRelire: false). Les entrées déjà présentes ne sont jamais modifiées.
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { mastra } from "../src/mastra/index.js";
import { assertModelKey, config, PASSAGES_INDEX } from "../src/config.js";
import { pgVector, retrievalDeps } from "../src/corpus/deps.js";
import { repondre } from "../src/aec/repondre.js";
import { DEFAULT_JUDGE_MODEL } from "../src/mastra/scorers/index.js";
import {
  enParallele,
  etiqueter,
  fusionner,
  idPour,
  suitesDeSortie,
  texteDeSortie,
  type Origine,
  type SuiteDonnee,
  type Verdict,
} from "../src/aec/suites-donnees.js";

const { values } = parseArgs({
  options: {
    reelles: { type: "boolean", default: false },
    rejouer: { type: "boolean", default: false },
    jours: { type: "string", default: "30" },
    passages: { type: "string" },
    voisines: { type: "string" },
    sortie: { type: "string", default: "evals/suites.json" },
  },
});
const toutes = !values.reelles && !values.rejouer && values.passages === undefined && values.voisines === undefined;
const nPassages = Number(values.passages ?? (toutes ? 50 : 0));
const nVoisines = Number(values.voisines ?? (toutes ? 50 : 0));
const avecReelles = toutes || values.reelles || values.rejouer;
const LLM_CONCURRENCE = 4;
const TOP_K = 8;

assertModelKey(DEFAULT_JUDGE_MODEL);
const llm = new Agent({
  id: "suites-donnees",
  name: "suites-donnees",
  instructions:
    "Tu prépares un jeu de test pour un assistant documentaire sur le programme « L'Avenir en commun ». " +
    "Tu écris en français, comme un électeur ou un militant qui pose une question courte au bot.",
  model: DEFAULT_JUDGE_MODEL as never,
});

async function json<T>(prompt: string, schema: z.ZodType<T>): Promise<T> {
  const res = await llm.generate(prompt, { structuredOutput: { schema } });
  return res.object as T;
}

const editions = config().EDITIONS;
const pool = pgVector().pool;
const brutes: { question: string; origine: Origine; contexte?: string }[] = [];

// 1. Suites réelles, avant filtrage : le texte brut du modèle est la sortie du span racine de chaque trace.
if (avecReelles) {
  const obs = (await mastra.getStorage()?.getStore("observability")) as any;
  const start = new Date(Date.now() - Number(values.jours) * 86_400_000);
  const racines: { traceId: string; output?: unknown }[] = [];
  for (let page = 0; !values.rejouer; page++) {
    const res = (await obs.listTraces({
      filters: { startedAt: { start } },
      pagination: { page, perPage: 100 },
    })) as { spans: { traceId: string; output?: unknown }[] };
    racines.push(...res.spans);
    if (res.spans.length < 100) break;
  }
  let n = 0;
  await enParallele(racines, 5, async (r) => {
    let output = r.output;
    if (texteDeSortie(output) === undefined) output = (await obs.getRootSpan({ traceId: r.traceId }))?.span?.output;
    const suites = suitesDeSortie(output);
    n += suites.length;
    // Pas la question de l'utilisateur : ce fichier est versionné, et les questions ne doivent pas
    // survivre à MEMORY_DAYS. La suite, écrite par le modèle, ne dit rien de la personne.
    for (const question of suites) brutes.push({ question, origine: "reelle" });
  });
  if (!values.rejouer) console.log(`Suites réelles : ${n} dans ${racines.length} trace(s) des ${values.jours} derniers jours`);

  // Sans traces en base : on rejoue les questions encore en mémoire, et on garde les suites
  // avant le filtre par score, y compris celles que le seuil aurait retirées.
  if (racines.length === 0) {
    const { rows } = await pool.query(
      `SELECT DISTINCT content FROM aec_conversations
        WHERE role = 'user' AND created_at > now() - make_interval(days => $1) AND length(content) >= 10`,
      [Number(values.jours)],
    );
    console.log(`${values.rejouer ? "Rejeu demandé" : "Pas de trace"} : ${rows.length} question(s) rejouée(s) depuis aec_conversations…`);
    let m = 0;
    await enParallele(rows as { content: string }[], 3, async ({ content }) => {
      try {
        // Les suites que la vérification garde (elles citent un passage reçu), avant le filtre par score.
        const suites = (await repondre(content)).suitesAvantFiltre;
        m += suites.length;
        // Comme plus haut : la suite seule, jamais la question de l'utilisateur.
        for (const question of suites) brutes.push({ question, origine: "reelle" });
      } catch (e) {
        console.log(`  échec d'une question rejouée : ${(e as Error).message}`);
      }
    });
    console.log(`Suites réelles (rejouées) : ${m}`);
  }
}

// Passages tirés au hasard, répartis entre les documents des éditions interrogées.
async function passagesAuHasard(n: number): Promise<{ title: string; page: unknown; text: string }[]> {
  if (n <= 0) return [];
  const { rows } = await pool.query(
    `SELECT metadata->>'title' AS title, metadata->>'page' AS page, metadata->>'text' AS text FROM (
       SELECT metadata, row_number() OVER (PARTITION BY metadata->>'docId' ORDER BY random()) AS rn
         FROM ${PASSAGES_INDEX}
        WHERE metadata->>'corpus' = ANY($1) AND length(metadata->>'text') > 400
     ) t WHERE rn <= 3 ORDER BY random() LIMIT $2`,
    [editions, n],
  );
  return rows;
}

// 2. Questions auxquelles un passage répond, reformulées pour ne pas recopier le texte.
if (nPassages > 0) {
  const passages = await passagesAuHasard(nPassages);
  const out = await enParallele(passages, LLM_CONCURRENCE, (p) =>
    json(
      `Passage (${p.title}, page ${p.page}) :\n${p.text}\n\n` +
        "Écris UNE question à laquelle ce passage répond clairement. Contraintes : moins de 120 caractères, " +
        "se termine par « ? », n'emploie pas les mots exacts du passage (reformule comme un électeur), " +
        "ne cite pas le titre du document.",
      z.object({ question: z.string() }),
    ).then((r) => ({ ...r, contexte: `${p.title}, p. ${p.page}` })),
  );
  for (const r of out) brutes.push({ question: r.question.trim(), origine: "passage", contexte: r.contexte });
  console.log(`Questions depuis des passages : ${out.length}`);
}

// 3. Questions voisines : même thème qu'un passage, mais sur un point que le programme ne traite probablement pas.
if (nVoisines > 0) {
  const passages = await passagesAuHasard(Math.ceil(nVoisines / 2));
  const out = await enParallele(passages, LLM_CONCURRENCE, (p) =>
    json(
      `Thème, d'après un passage du programme (${p.title}) :\n${p.text}\n\n` +
        "Écris DEUX questions qu'un électeur pourrait poser au bot, proches de ce thème, mais auxquelles un " +
        "programme politique comme celui-ci ne répond probablement pas. Varie les pièges : un sujet voisin " +
        "(ex. le changement d'heure à côté des prix de l'énergie), un détail absent d'une mesure (calendrier, " +
        "coût précis, cas particulier), une question d'actualité ou de personne. Moins de 120 caractères, " +
        "terminées par « ? ».",
      z.object({ questions: z.array(z.string()).length(2) }),
    ),
  );
  for (const r of out) for (const q of r.questions) brutes.push({ question: q.trim(), origine: "voisine" });
  console.log(`Questions voisines : ${out.length * 2}`);
}

// Dédoublonnage contre le fichier existant avant de payer le juge.
const fichier = values.sortie!;
const existant: SuiteDonnee[] = await readFile(fichier, "utf8").then(JSON.parse, () => []);
const ids = new Set(existant.map((d) => d.id));
const candidates = fusionner(
  existant,
  brutes
    .filter((b) => b.question.endsWith("?"))
    .map((b) => ({ ...b, id: "", attendu: "introuvable" as Verdict, aRelire: true })),
).donnees.slice(existant.length);

// Juge : les 8 meilleurs passages répondent-ils à la question ?
const { embedder, vector } = await retrievalDeps();
const vecteurs: number[][] = [];
for (let i = 0; i < candidates.length; i += 32) vecteurs.push(...(await embedder.embed(candidates.slice(i, i + 32).map((c) => c.question))));

const Juge = z.object({ verdict: z.enum(["repondu", "partiel", "introuvable"]), raison: z.string() });
let faits = 0;
const nouvelles = await enParallele(candidates, LLM_CONCURRENCE, async (c, i) => {
  const hits = await vector.query({
    indexName: PASSAGES_INDEX,
    queryVector: vecteurs[i]!,
    topK: TOP_K,
    filter: { corpus: { $in: editions } } as never,
  });
  const contexte = hits
    .map((h, k) => `[${k + 1}] ${h.metadata?.title}, page ${h.metadata?.page ?? "web"}\n${h.metadata?.text}`)
    .join("\n\n");
  const juge = await json(
    `Question : ${c.question}\n\nPassages trouvés dans le programme :\n${contexte}\n\n` +
      "Ces passages permettent-ils de répondre à la question ?\n" +
      "- repondu : au moins un passage y répond directement.\n" +
      "- partiel : ils traitent du sujet mais ne répondent pas à ce qui est demandé précisément.\n" +
      "- introuvable : aucun passage ne traite de ce qui est demandé (un thème proche ne suffit pas).\n" +
      "Raison : une phrase, en citant le numéro du passage utile s'il y en a un.",
    Juge,
  );
  if (++faits % 10 === 0) console.log(`  jugées : ${faits}/${candidates.length}`);
  return { ...c, id: idPour(c.origine, c.question, ids), juge, ...etiqueter(c.origine, juge) } satisfies SuiteDonnee;
});

const { donnees, ajoutees } = fusionner(existant, nouvelles);
await writeFile(fichier, `${JSON.stringify(donnees, null, 2)}\n`);

const compte = (o: Origine, v: Verdict) => nouvelles.filter((d) => d.origine === o && d.attendu === v).length;
console.log(`\n${ajoutees} entrée(s) ajoutée(s) à ${fichier} (${donnees.length} au total)`);
for (const o of ["reelle", "passage", "voisine"] as const) {
  console.log(`  ${o.padEnd(8)} repondu ${compte(o, "repondu")} · partiel ${compte(o, "partiel")} · introuvable ${compte(o, "introuvable")}`);
}
const aRelire = nouvelles.filter((d) => d.aRelire);
console.log(`\n${aRelire.length} à relire (désaccord avec le juge, ou « partiel ») :`);
for (const d of aRelire) console.log(`  ${d.id}\n    « ${d.question} » → juge : ${d.juge!.verdict} — ${d.juge!.raison}`);
process.exit(0);
