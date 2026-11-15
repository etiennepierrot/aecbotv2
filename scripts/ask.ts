/**
 * Pose une question à l'agent depuis le terminal, réponse vérifiée.
 *   pnpm ask "Qu'est-ce que le programme dit sur la retraite ?"
 *   pnpm ask --model openai/gpt-5-mini "…"
 */
import { parseArgs } from "node:util";
import { mastra } from "../src/mastra/index.js";
import { repondre } from "../src/aec/repondre.js";
import { pgVector } from "../src/corpus/deps.js";
import { assertModelKey } from "../src/config.js";
import { DEFAULT_MODEL } from "../src/mastra/agents/aec.js";

const { values, positionals } = parseArgs({ options: { model: { type: "string" } }, allowPositionals: true });
const question = positionals.join(" ").trim();
if (!question) {
  console.error('Usage : pnpm ask "ta question"');
  process.exit(1);
}

assertModelKey(values.model ?? DEFAULT_MODEL);
const { reponse, brut, usage } = await repondre(question, { model: values.model });
console.log(`\n${reponse.texte}\n`);
for (const s of reponse.sources) {
  console.log(`[${s.n}] ${s.title} — ${s.pages.length ? `p. ${s.pages.join(", ")}` : "page web"}  ${s.url}`);
}
for (const a of reponse.avertissements) console.log(`⚠ ${a}`);
const c = reponse.controle;
console.log(
  `\n${c.passagesRecuperes} passages · ${c.citationsValides} citations valides · ${c.citationsRejetees} rejetées · ` +
    `${c.phrasesRetirees} phrases retirées · ${usage.inputTokens}+${usage.outputTokens} jetons`,
);
if (c.citationsRejetees || c.phrasesRetirees) console.log(`\nTexte brut du modèle :\n${brut}`);
// Les spans partent par lots : les écrire en base avant de quitter.
await (mastra.observability as unknown as { flush?: () => Promise<void> }).flush?.();
await pgVector().pool.end();
