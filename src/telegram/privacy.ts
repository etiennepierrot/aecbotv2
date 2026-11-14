import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * Pseudonyme stable d'un utilisateur Telegram (HMAC-SHA256 avec une clé secrète).
 * L'identifiant Telegram ne sort jamais du gestionnaire de messages : il n'est ni
 * stocké, ni journalisé, ni transmis à l'agent.
 */
export function pseudonymize(telegramUserId: number, secret: string): string {
  return `u_${createHmac("sha256", secret).update(String(telegramUserId)).digest("hex").slice(0, 24)}`;
}

/**
 * Identifiant de discussion chiffré (AES-256-GCM, clé dérivée du secret de pseudonymisation).
 * Stocké seulement avec un avis, pour que l'équipe puisse y répondre ; effacé avec l'avis.
 */
export function sealChatId(chatId: number, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", chatKey(secret), iv);
  const data = Buffer.concat([cipher.update(String(chatId), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

export function openChatId(sealed: string, secret: string): number {
  const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
  if (!iv || !tag || !data) throw new Error("identifiant chiffré illisible");
  const decipher = createDecipheriv("aes-256-gcm", chatKey(secret), iv);
  decipher.setAuthTag(tag);
  return Number(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
}

function chatKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("aecbot:chat-id").digest();
}
