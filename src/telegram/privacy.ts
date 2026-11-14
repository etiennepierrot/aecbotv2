import { createHmac } from "node:crypto";

/**
 * Pseudonyme stable d'un utilisateur Telegram (HMAC-SHA256 avec une clé secrète).
 * L'identifiant Telegram ne sort jamais du gestionnaire de messages : il n'est ni
 * stocké, ni journalisé, ni transmis à l'agent.
 */
export function pseudonymize(telegramUserId: number, secret: string): string {
  return `u_${createHmac("sha256", secret).update(String(telegramUserId)).digest("hex").slice(0, 24)}`;
}
