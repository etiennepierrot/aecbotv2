/**
 * Derniers avis généraux (/avis) envoyés au bot.
 *   pnpm avis:prod            ceux des 30 derniers jours
 *   pnpm avis:prod --jours 7  ceux des 7 derniers jours
 * Pour répondre : dans Telegram, répondre à la notification ou « /repondre numéro texte ».
 */
import { parseArgs } from "node:util";
import { botStore } from "../src/telegram/runtime.js";

const { values } = parseArgs({ options: { jours: { type: "string", default: "30" } } });
const avis = await botStore().listAvis({ jours: Number(values.jours), limit: 200 });
console.log(`${avis.length} avis sur les ${values.jours} derniers jours\n`);
for (const a of avis) {
  console.log(`n° ${a.id}  ${a.createdAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}  ${a.pseudo.slice(0, 10)}`);
  console.log(`  ${a.texte.replace(/\n/g, "\n  ")}\n`);
}
process.exit(0);
