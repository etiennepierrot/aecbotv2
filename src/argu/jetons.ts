import { createHash, randomBytes } from "node:crypto";
import type { ArguStore } from "./store.js";

/**
 * Jetons personnels de l'extension. Un membre de l'équipe les obtient par /jeton sur Telegram ;
 * seule l'empreinte SHA-256 est stockée, avec son pseudonyme : une fuite de la base ne donne
 * aucun jeton utilisable. Un jeton volé se révoque par /jeton revoquer.
 */

const PREFIXE = "aec_";

export function empreinteJeton(jeton: string): string {
  return createHash("sha256").update(jeton).digest("hex");
}

/** Crée un jeton (32 octets aléatoires) et révoque les précédents du membre. Le jeton n'est renvoyé qu'ici. */
export async function creerJeton(store: Pick<ArguStore, "remplacerJeton">, pseudonyme: string): Promise<string> {
  const jeton = PREFIXE + randomBytes(32).toString("base64url");
  await store.remplacerJeton(pseudonyme, empreinteJeton(jeton));
  return jeton;
}

/** Le pseudonyme du membre pour un en-tête « Authorization: Bearer … » valable, sinon undefined. */
export async function verifierJeton(
  store: Pick<ArguStore, "jetonActif">,
  authorization: string | undefined | null,
): Promise<string | undefined> {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization?.trim() ?? "");
  if (!m || !m[1]!.startsWith(PREFIXE)) return undefined;
  return store.jetonActif(empreinteJeton(m[1]!));
}
