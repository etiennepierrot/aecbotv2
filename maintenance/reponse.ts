/**
 * Réponse de maintenance, renvoyée quand le serveur principal est en panne.
 *
 * Telegram accepte qu'on réponde à un webhook par un appel de méthode dans le corps HTTP
 * (`{"method": "sendMessage", …}`) : le Worker n'a donc pas besoin du token du bot.
 * Il vérifie seulement l'en-tête secret, sinon n'importe qui pourrait faire écrire le bot
 * à un chat_id de son choix.
 */

export const MESSAGE_MAINTENANCE =
  "⚠️ Le service est momentanément indisponible à cause d'une panne chez notre hébergeur. " +
  "Je ne peux pas répondre à ta question pour l'instant. Nous travaillons à le rétablir : " +
  "réessaie un peu plus tard, merci de ta patience.";

export const ALERTE_BOUTON = "⚠️ Service momentanément indisponible, réessaie plus tard.";

type Update = {
  message?: { chat?: { id?: number; type?: string } };
  callback_query?: { id?: string };
};

export type Reponse = { status: number; body: Record<string, unknown> | null };

export function reponseMaintenance(update: unknown, secretRecu: string | null, secretAttendu: string): Reponse {
  if (!secretAttendu || secretRecu !== secretAttendu) return { status: 401, body: null };
  const u = (update ?? {}) as Update;

  const chat = u.message?.chat;
  // Seulement en privé : dans un groupe, chaque message du groupe déclencherait l'alerte.
  if (typeof chat?.id === "number" && chat.type === "private") {
    return { status: 200, body: { method: "sendMessage", chat_id: chat.id, text: MESSAGE_MAINTENANCE } };
  }
  if (typeof u.callback_query?.id === "string") {
    return {
      status: 200,
      body: { method: "answerCallbackQuery", callback_query_id: u.callback_query.id, text: ALERTE_BOUTON, show_alert: true },
    };
  }
  return { status: 200, body: null };
}
