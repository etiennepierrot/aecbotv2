/**
 * Branche le bot sur le serveur déployé.
 *   pnpm webhook https://mon-projet.mastra.cloud      → setWebhook sur …/telegram avec le secret
 *   pnpm webhook --info                               → état du webhook
 */
import { parseArgs } from "node:util";
import { Api } from "grammy";
import { config } from "../src/config.js";

const { values, positionals } = parseArgs({ options: { info: { type: "boolean" } }, allowPositionals: true });
const cfg = config();
if (!cfg.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN manquant");
const api = new Api(cfg.TELEGRAM_BOT_TOKEN);

if (!values.info) {
  const base = positionals[0];
  if (!base?.startsWith("https://")) throw new Error("Donne l'URL https du serveur déployé");
  if (!cfg.TELEGRAM_WEBHOOK_SECRET) throw new Error("TELEGRAM_WEBHOOK_SECRET manquant");
  const url = `${base.replace(/\/$/, "")}/telegram`;
  await api.setWebhook(url, {
    secret_token: cfg.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
  await api.setMyCommands([
    { command: "aide", description: "Comment ça marche" },
    { command: "oublier", description: "Effacer mes échanges" },
  ]);
  console.log(`Webhook branché sur ${url}`);
}
const info = await api.getWebhookInfo();
console.log({ url: info.url, pending: info.pending_update_count, lastError: info.last_error_message });
