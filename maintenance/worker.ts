/**
 * Cloudflare Worker de secours : quand le webhook Telegram pointe ici, chaque message reçoit
 * un avis de panne. Déploiement et bascule : workflow « Maintenance du bot » (voir README).
 */
import { reponseMaintenance } from "./reponse.js";

type Env = { TELEGRAM_WEBHOOK_SECRET: string };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("Bot en maintenance", { status: 200 });
    const update: unknown = await request.json().catch(() => null);
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    const { status, body } = reponseMaintenance(update, secret, env.TELEGRAM_WEBHOOK_SECRET);
    if (!body) return new Response(null, { status });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  },
};
