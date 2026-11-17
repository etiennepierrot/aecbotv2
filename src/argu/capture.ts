import { createHash } from "node:crypto";
import type { ArguStore } from "./store.js";
import { CaptureInput, type Canal, TEXTE_MAX } from "./types.js";

/**
 * Point d'entrée unique de toutes les captures : la route POST /capture (extension), la commande
 * /capter du bot et les collectes automatiques passent par ici. Validation, déduplication et
 * déclenchement de la consolidation sont donc les mêmes quel que soit le canal.
 */

export type ResultatCapture =
  | { ok: true; id: string; doublon: boolean }
  | { ok: false; code: 413 | 422; champ: string | null; message: string };

export interface CaptureDeps {
  store: Pick<ArguStore, "insererCapture">;
  /** Lance la consolidation d'une capture. Pas attendu : la capture est acquise même si l'analyse échoue. */
  lancerConsolidation?: (captureId: string) => Promise<unknown>;
  logger?: { error: (msg: string, meta?: object) => void };
}

export async function enregistrerCapture(
  body: unknown,
  origine: { capturePar: string; canal: Canal },
  deps: CaptureDeps,
): Promise<ResultatCapture> {
  // Trop long d'abord : c'est un 413 (contenu valide mais trop gros), pas un corps invalide.
  const brut = (body as { texte?: unknown } | null)?.texte;
  if (typeof brut === "string" && brut.trim().length > TEXTE_MAX) {
    return { ok: false, code: 413, champ: "texte", message: `texte trop long (${TEXTE_MAX} caractères au plus)` };
  }
  const parsed = CaptureInput.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, code: 422, champ: issue?.path.join(".") || null, message: issue?.message ?? "corps invalide" };
  }
  const c = parsed.data;
  const url = c.url ? normaliserUrl(c.url) : undefined;
  const { id, doublon } = await deps.store.insererCapture({
    sourceType: c.source_type,
    url,
    texte: c.texte,
    auteurNom: c.auteur?.nom || undefined,
    auteurIdentifiant: c.auteur?.identifiant || undefined,
    publieLe: c.publie_le,
    extras: c.extras,
    note: c.note || undefined,
    capturePar: origine.capturePar,
    canal: origine.canal,
    empreinte: empreinte(url, c.texte),
  });
  // Un doublon ne relance rien : la capture existante a déjà été (ou sera) consolidée.
  if (!doublon && deps.lancerConsolidation) {
    deps.lancerConsolidation(id).catch((e) =>
      deps.logger?.error("consolidation non lancée", { capture: id, erreur: e instanceof Error ? e.message : String(e) }),
    );
  }
  return { ok: true, id, doublon };
}

/** Paramètres qui ne changent pas le contenu désigné : suivi, partage, provenance. */
const PARAMS_SUIVI = /^(utm_.*|fbclid|gclid|mc_[a-z]+|igshid|ref|ref_src|ref_url|si|feature|pp)$/i;
/** Sur X, `s` et `t` identifient le partage, pas le post. Sur YouTube, `t` est l'horodatage : on le garde. */
const PARAMS_X = /^(s|t)$/i;

/**
 * URL canonique d'un contenu, pour que le même post partagé deux fois ait la même empreinte :
 * hôte en minuscules sans www ni mobile, twitter.com → x.com, sans fragment ni paramètres de suivi.
 */
export function normaliserUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  let host = u.hostname.toLowerCase().replace(/^(www|mobile|m)\./, "");
  if (host === "twitter.com") host = "x.com";
  u.hostname = host;
  for (const k of [...u.searchParams.keys()]) {
    if (PARAMS_SUIVI.test(k) || (host === "x.com" && PARAMS_X.test(k))) u.searchParams.delete(k);
  }
  u.searchParams.sort();
  let out = u.toString();
  if (u.pathname.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** Texte comparé sans tenir compte des espaces ni de la forme Unicode. */
export function normaliserTexte(texte: string): string {
  return texte.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Empreinte de déduplication : même contenu au même endroit. */
export function empreinte(url: string | undefined, texte: string): string {
  return createHash("sha256").update(`${url ?? ""}\n${normaliserTexte(texte)}`).digest("hex");
}
