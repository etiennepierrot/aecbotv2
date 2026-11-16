/**
 * Le rapport des discussions du bot, dans le terminal (le même que celui envoyé chaque matin
 * à l'équipe par le workflow `rapport`, si RAPPORT_CRON est défini).
 *   pnpm rapport:prod                  les dernières 24 h
 *   pnpm rapport:prod --jours 7        les 7 derniers jours
 *   pnpm rapport:prod --tout           toutes les questions à revoir, sans limite par rubrique
 *   pnpm rapport:prod --envoyer        l'envoie aussi sur Telegram à TEAM_TELEGRAM_IDS (pour essayer)
 */
import { parseArgs } from "node:util";
import { mastra } from "../src/mastra/index.js";
import { botStore } from "../src/telegram/runtime.js";
import { collecterRapport, enTexte, formatRapport, votesDepuisObservabilite } from "../src/telegram/rapport.js";

const { values } = parseArgs({
  options: {
    jours: { type: "string", default: "1" },
    tout: { type: "boolean", default: false },
    envoyer: { type: "boolean", default: false },
  },
});

try {
  if (values.envoyer) {
    const run = await mastra.getWorkflow("rapport").createRun();
    const res = await run.start({ inputData: { heures: Math.round(Number(values.jours) * 24) } });
    if (res.status !== "success") throw new Error(`Envoi impossible (${res.status})`);
    const r = res.result;
    console.log(`Rapport envoyé à ${r.envoyes}/${r.destinataires} membre(s) de l'équipe, en ${r.messages} message(s).`);
  } else {
    const jusqua = new Date();
    const depuis = new Date(jusqua.getTime() - Number(values.jours) * 86_400_000);
    const obs = (await mastra.getStorage()?.getStore("observability")) as never;
    const donnees = await collecterRapport({ store: botStore(), votesDepuis: votesDepuisObservabilite(obs) }, depuis, jusqua);
    console.log(enTexte(formatRapport(donnees, { maxParListe: values.tout ? Infinity : 10 })));
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
process.exit();
