/**
 * L'argumentaire depuis le terminal, en attendant l'interface /admin (étape 3).
 *   pnpm argu:prod lister                  brouillons à relire, les plus récents d'abord
 *   pnpm argu:prod voir <capture>          une capture, son profil d'émetteur et ses affirmations
 *   pnpm argu:prod valider <affirmation>   (préfixe d'identifiant accepté)
 *   pnpm argu:prod rejeter <affirmation>
 *   pnpm argu:prod relancer <capture>      reconsolide une capture (les brouillons sont remplacés)
 *   pnpm argu:prod relancer --attente      consolide les captures en attente (plafond, panne)
 *   pnpm argu capturer --source x --url https://x.com/… --texte "…"   (essai en local)
 * (`pnpm argu …` fait la même chose sur la base locale de .env)
 */
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { enregistrerCapture } from "../src/argu/capture.js";
import { consolider } from "../src/argu/consolidation.js";
import { arguStore, consolidationDeps } from "../src/argu/deps.js";
import type { AffirmationRow } from "../src/argu/store.js";

const { values, positionals } = parseArgs({
  options: {
    attente: { type: "boolean" },
    source: { type: "string", default: "web" },
    url: { type: "string" },
    texte: { type: "string" },
    auteur: { type: "string" },
  },
  allowPositionals: true,
});
const [cmd, arg] = positionals;
const qui = `cli:${userInfo().username}`;
const store = arguStore();
const court = (id: string) => id.slice(0, 8);
const logger = { info: () => undefined, error: (msg: string, meta?: object) => console.error(msg, meta ?? "") };

function afficher(a: AffirmationRow) {
  const notes = Object.entries(a.force).map(([k, v]) => `${k} ${v.note}`).join(", ");
  console.log(`${court(a.id)}  [${a.statut}] ${a.position ?? "?"} · ${a.types.join(", ") || "sans type"} · ${a.theme ?? "-"} / ${a.registre ?? "-"}`);
  console.log(`  ${a.texte}`);
  console.log(`  « ${a.citation} »`);
  if (notes) console.log(`  force : ${notes}`);
  if (a.publics.length) console.log(`  publics (hypothèse) : ${a.publics.map((p) => p.code).join(", ")}`);
  if (a.aVerifier) console.log("  ⚠ fake_news retiré faute de source de vérification : à vérifier");
  if (a.propositions.length) console.log(`  objections proches : ${a.propositions.map((p) => `${p.intitule} (${p.score.toFixed(2)})`).join(" ; ")}`);
}

async function relancer(id: string) {
  const r = await consolider(await consolidationDeps(logger), id, { relance: true });
  console.log(r.arret ? `${court(id)} : non consolidée (${r.arret})` : `${court(id)} : ${r.ids.length} affirmation(s), ${r.citationsRejetees} citation(s) introuvable(s)`);
}

try {
  if (cmd === "lister") {
    const brouillons = await store.affirmations({ statut: "brouillon" });
    if (brouillons.length === 0) console.log("Aucun brouillon à relire.");
    for (const a of brouillons) {
      console.log(`— capture ${court(a.captureId)}`);
      afficher(a);
    }
  } else if (cmd === "voir") {
    if (!arg) throw new Error("Donne l'identifiant de la capture");
    const c = await store.capture(arg);
    if (!c) throw new Error("Capture introuvable (identifiant complet attendu)");
    console.log(`${c.sourceType} · ${c.auteurNom ?? ""} ${c.auteurIdentifiant ?? ""} · ${c.statut}${c.erreur ? ` (${c.erreur})` : ""}`);
    console.log(c.url ?? "(sans lien)");
    console.log(c.texte);
    if (c.emetteurProfil) {
      const t = (x: { code: string; origine: string; justification: string }) => `${x.code} (${x.origine} : ${x.justification})`;
      console.log(`Émetteur, hypothèse réservée à l'équipe : classe ${t(c.emetteurProfil.classe_sociale)} ; orientation ${t(c.emetteurProfil.orientation)}`);
    }
    for (const a of await store.affirmations({ captureId: c.id })) afficher(a);
  } else if (cmd === "valider" || cmd === "rejeter") {
    if (!arg) throw new Error("Donne l'identifiant de l'affirmation");
    const a = await store.deciderAffirmation(arg, cmd === "valider" ? "validee" : "rejetee", qui);
    console.log(`${court(a.id)} : ${a.statut}`);
  } else if (cmd === "relancer") {
    const ids = values.attente ? await store.capturesEnAttente() : arg ? [arg] : [];
    if (ids.length === 0) throw new Error(values.attente ? "Aucune capture en attente." : "Donne l'identifiant de la capture, ou --attente");
    for (const id of ids) await relancer(id);
  } else if (cmd === "capturer") {
    const r = await enregistrerCapture(
      { source_type: values.source, url: values.url, texte: values.texte, auteur: values.auteur ? { nom: values.auteur } : undefined },
      { capturePar: qui, canal: "cli" },
      { store },
    );
    if (!r.ok) throw new Error(`${r.code} ${r.champ ?? ""} : ${r.message}`);
    console.log(r.doublon ? `Doublon de ${r.id}` : `Capture ${r.id}`);
    if (!r.doublon) await relancer(r.id);
  } else {
    console.log("Usage : pnpm argu:prod lister | voir <capture> | valider <id> | rejeter <id> | relancer <capture>|--attente | capturer --source … --url … --texte …");
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
process.exit();
