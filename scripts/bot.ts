/**
 * Lance le bot en local, en long polling (pas besoin d'URL publique).
 *   pnpm bot
 * Supprime le webhook éventuel : à ne pas lancer contre le bot de production.
 */
import { mastra } from "../src/mastra/index.js";
import { botFromEnv } from "../src/telegram/runtime.js";

const bot = botFromEnv(
  { info: (msg, meta) => console.log(msg, meta ?? ""), error: (msg, meta) => console.error(msg, meta ?? "") },
  mastra,
);
await bot.api.deleteWebhook();
await bot.start({
  allowed_updates: ["message", "callback_query"],
  onStart: (me) => console.log(`@${me.username} écoute en long polling. Ctrl+C pour arrêter.`),
});
