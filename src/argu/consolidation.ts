import type { RetrievedPassage } from "../aec/types.js";
import type { Embedder } from "../corpus/embed.js";
import type { AffirmationAEvaluer, Analyseur, CaptureAnalysee, Extraction, ReferentielsActifs } from "./analyse.js";
import { figureDans } from "./citations.js";
import { type Force, noteFrequence, notePortee } from "./force.js";
import { regleFakeNews, verifierProfil } from "./regles.js";
import type { ArguStore, CaptureRow, NouvelleAffirmation, PropositionObjection } from "./store.js";

/**
 * La consolidation d'une capture, en phases (une étape du workflow Mastra chacune) :
 * préparer → analyser (extraction, citations, profil de l'émetteur) → rapprocher du programme →
 * évaluer → regrouper → enregistrer. Elle ne produit que des brouillons : rien n'est publié
 * sans validation humaine.
 */

export interface ConsolidationDeps {
  store: Pick<
    ArguStore,
    | "capture" | "majCapture" | "consolideesAujourdhui" | "referentiel" | "enregistrerProfilEmetteur"
    | "remplacerBrouillons" | "objectionsProches" | "verificationProche" | "journaliser"
  >;
  analyseur: Analyseur;
  /** Recherche dans le programme (catégories du mode programme seulement). */
  rechercher: (requete: string) => Promise<RetrievedPassage[]>;
  embedder: Embedder;
  /** Prévient l'équipe (Telegram). Le message ne contient jamais le profil de l'émetteur. */
  notifier?: (message: string) => Promise<void>;
  maxParJour: number;
  /** Similarité minimale pour proposer une objection existante. */
  seuilRegroupement: number;
  /** Similarité minimale pour qu'un debunk validé serve de source de vérification. */
  seuilVerification: number;
  adminUrl?: string;
  logger?: { info: (msg: string, meta?: object) => void; error: (msg: string, meta?: object) => void };
}

/** Affirmation en cours de traitement, enrichie phase après phase. */
export interface Brouillon {
  texte: string;
  citation: string;
  types: string[];
  position: "pour" | "contre" | "neutre";
  theme: string | null;
  registre: string | null;
  passages: PassageProgramme[];
  force: Partial<Force>;
  publics: { code: string; justification: string }[];
  familles: { code: string; justification: string }[];
}

export interface PassageProgramme {
  docId: string;
  titre: string;
  section: string | null;
  page: number | null;
  url: string;
  score: number;
  extrait: string;
}

export interface Etat {
  captureId: string;
  /** Raison pour laquelle la consolidation s'arrête sans brouillon (plafond, lien seul…). */
  arret: string | null;
  auteurType: string;
  brouillons: Brouillon[];
  citationsRejetees: number;
}

const etatInitial = (captureId: string): Etat => ({ captureId, arret: null, auteurType: "inconnu", brouillons: [], citationsRejetees: 0 });

const capturePourModele = (c: CaptureRow): CaptureAnalysee => ({
  sourceType: c.sourceType, texte: c.texte, url: c.url, auteurNom: c.auteurNom,
  auteurIdentifiant: c.auteurIdentifiant, extras: c.extras, note: c.note,
});

async function chargerCapture(d: ConsolidationDeps, id: string): Promise<CaptureRow> {
  const c = await d.store.capture(id);
  if (!c) throw new Error(`Capture introuvable : ${id}`);
  return c;
}

async function referentiels(d: ConsolidationDeps): Promise<ReferentielsActifs> {
  const [categories, themes, registres, classes, familles, publics] = await Promise.all(
    ["categorie", "theme", "registre", "classe_sociale", "famille", "public"].map((t) => d.store.referentiel(t)),
  );
  return { categories: categories!, themes: themes!, registres: registres!, classes: classes!, familles: familles!, publics: publics! };
}

// --- 1. Préparer -------------------------------------------------------------------------------

/** Paramètres de suivi retirés des liens cités dans le texte. */
const SUIVI = /([?&])(utm_[a-z]+|fbclid|gclid|si|igshid|ref_src)=[^&\s]*/gi;

export function nettoyerTexte(texte: string): string {
  return texte
    .replace(/https?:\/\/\S+/g, (u) => u.replace(SUIVI, "$1").replace(/[?&]+$/, "").replace(/\?&/, "?"))
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Un ou plusieurs liens, sans texte autour : on ne lit pas la page nous-mêmes. */
export const estLienSeul = (texte: string) => texte.replace(/https?:\/\/\S+/g, "").replace(/[\s\p{P}]/gu, "").length < 3;

export async function preparer(d: ConsolidationDeps, captureId: string, opts: { relance?: boolean } = {}): Promise<Etat> {
  const etat = etatInitial(captureId);
  const c = await chargerCapture(d, captureId);
  if (c.statut === "traitee" && !opts.relance) return { ...etat, arret: "déjà consolidée" };
  // Le plafond protège contre un emballement des collectes : la capture reste « reçue », pour plus tard.
  if ((await d.store.consolideesAujourdhui()) >= d.maxParJour) return { ...etat, arret: "plafond quotidien atteint" };
  const texte = nettoyerTexte(c.texte);
  if (estLienSeul(texte)) {
    const erreur = "lien seul, sans texte : il faut le texte ou une capture d'écran";
    await d.store.majCapture(captureId, { statut: "erreur", erreur, traitee: true });
    return { ...etat, arret: erreur };
  }
  if (texte !== c.texte) await d.store.majCapture(captureId, { texte });
  return etat;
}

// --- 2. Analyser : extraction, citations vérifiées, profil de l'émetteur -----------------------

export function brouillonsVerifies(extraction: Extraction, texte: string, r: ReferentielsActifs) {
  const codes = (l: { code: string }[]) => new Set(l.map((x) => x.code));
  const [categories, themes, registres] = [codes(r.categories), codes(r.themes), codes(r.registres)];
  const gardes: Brouillon[] = [];
  let rejetees = 0;
  for (const a of extraction.affirmations) {
    // Une citation introuvable mot pour mot : l'affirmation est écartée, jamais réparée.
    if (!figureDans(a.citation, texte)) {
      rejetees++;
      continue;
    }
    gardes.push({
      texte: a.texte.trim(),
      citation: a.citation.trim(),
      types: [...new Set(a.types)].filter((t) => categories.has(t)),
      position: a.position,
      theme: a.theme && themes.has(a.theme) ? a.theme : null,
      registre: a.registre && registres.has(a.registre) ? a.registre : null,
      passages: [],
      force: {},
      publics: [],
      familles: [],
    });
  }
  return { brouillons: gardes, rejetees };
}

export async function analyser(d: ConsolidationDeps, etat: Etat): Promise<Etat> {
  if (etat.arret) return etat;
  const c = await chargerCapture(d, etat.captureId);
  const r = await referentiels(d);
  const capture = capturePourModele(c);
  const [extraction, profilBrut] = await Promise.all([d.analyseur.extraire(capture, r), d.analyseur.profiler(capture, r)]);

  const { brouillons, rejetees } = brouillonsVerifies(extraction, c.texte, r);
  const profil = verifierProfil(profilBrut, { classes: r.classes.map((x) => x.code), familles: r.familles.map((x) => x.code) }, {
    texte: c.texte, auteurNom: c.auteurNom, auteurIdentifiant: c.auteurIdentifiant,
    bio: typeof c.extras?.bio === "string" ? c.extras.bio : null,
  });
  // Une correction de l'équipe fait foi : une relance ne l'écrase pas.
  const corrige = c.emetteurProfil?.classe_sociale.origine === "corrige" || c.emetteurProfil?.orientation.origine === "corrige";
  if (!corrige) {
    await d.store.enregistrerProfilEmetteur(c.id, { ...profil, modele: d.analyseur.modele, evalue_le: new Date().toISOString() });
  }
  // L'appartenance n'est gardée que si elle est déclarée : le prompt l'exige, le code n'a pas de quoi le vérifier.
  await d.store.majCapture(c.id, { auteurType: extraction.auteur_type, auteurAffiliation: extraction.auteur_affiliation?.trim() || null });
  return { ...etat, brouillons, citationsRejetees: rejetees, auteurType: extraction.auteur_type };
}

// --- 3. Rapprocher du programme ------------------------------------------------------------------

const EXTRAIT_MAX = 600;

export async function rapprocher(d: ConsolidationDeps, etat: Etat): Promise<Etat> {
  if (etat.arret) return etat;
  const brouillons = await Promise.all(
    etat.brouillons.map(async (b) => {
      const trouves = await d.rechercher(b.texte);
      const passages = trouves.slice(0, 5).map((p) => ({
        docId: p.docId, titre: p.title, section: p.section, page: p.page, url: p.url,
        score: p.score, extrait: p.text.slice(0, EXTRAIT_MAX),
      }));
      return { ...b, passages };
    }),
  );
  return { ...etat, brouillons };
}

// --- 4. Évaluer la force et les publics ---------------------------------------------------------

export async function evaluer(d: ConsolidationDeps, etat: Etat): Promise<Etat> {
  if (etat.arret || etat.brouillons.length === 0) return etat;
  const c = await chargerCapture(d, etat.captureId);
  const r = await referentiels(d);
  const aEvaluer: AffirmationAEvaluer[] = etat.brouillons.map((b) => ({
    texte: b.texte,
    passages: b.passages.map((p) => ({ titre: p.section ? `${p.titre}, « ${p.section} »` : p.titre, extrait: p.extrait })),
  }));
  const evaluations = await d.analyseur.evaluer(capturePourModele(c), aEvaluer, r);
  const publics = new Set(r.publics.map((x) => x.code));
  const familles = new Set(r.familles.map((x) => x.code));
  const portee = notePortee(etat.auteurType, c.extras);
  const brouillons = etat.brouillons.map((b, i) => {
    const e = evaluations.find((x) => x.n === i + 1);
    return {
      ...b,
      force: { ...(e ? { appui_factuel: e.appui_factuel, difficulte_reponse: e.difficulte_reponse } : {}), portee },
      publics: (e?.publics ?? []).filter((p) => publics.has(p.code)).slice(0, 3),
      familles: (e?.familles ?? []).filter((f) => familles.has(f.code)).slice(0, 3),
    };
  });
  return { ...etat, brouillons };
}

// --- 5 et 6. Regrouper, enregistrer, prévenir ---------------------------------------------------

/** Source de vérification fournie par la capture elle-même. */
function verificationDeLaCapture(c: CaptureRow): string | null {
  const v = c.extras?.verification_url;
  if (typeof v === "string" && v.startsWith("https://")) return v;
  // Un article d'un flux de vérification est lui-même la source.
  return c.sourceType === "rss" ? c.url : null;
}

export async function regrouperEtEnregistrer(d: ConsolidationDeps, etat: Etat): Promise<Etat & { ids: string[] }> {
  if (etat.arret) return { ...etat, ids: [] };
  const c = await chargerCapture(d, etat.captureId);
  const vecteurs = etat.brouillons.length ? await d.embedder.embed(etat.brouillons.map((b) => b.texte)) : [];
  const capturee = verificationDeLaCapture(c);

  const affirmations: NouvelleAffirmation[] = await Promise.all(
    etat.brouillons.map(async (b, i) => {
      const embedding = vecteurs[i] ?? null;
      const propositions: PropositionObjection[] = embedding ? await d.store.objectionsProches(embedding, 3, d.seuilRegroupement) : [];
      const verification =
        b.types.includes("fake_news") && !capturee && embedding
          ? await d.store.verificationProche(embedding, d.seuilVerification)
          : capturee;
      const fn = regleFakeNews(b.types, verification);
      return {
        texte: b.texte, citation: b.citation, types: fn.types, position: b.position, theme: b.theme, registre: b.registre,
        force: { ...b.force, frequence: noteFrequence((propositions[0]?.rattachees ?? 0) + 1) },
        publics: b.publics, familles: b.familles, passagesProgramme: b.passages,
        verificationUrl: fn.verificationUrl, aVerifier: fn.aVerifier, propositions, embedding,
      };
    }),
  );

  const ids = await d.store.remplacerBrouillons(c.id, affirmations);
  await d.store.majCapture(c.id, { statut: "traitee", erreur: null, traitee: true });
  await d.store.journaliser(
    "consolidation", "consolider", c.id,
    `${ids.length} affirmation(s), ${etat.citationsRejetees} citation(s) introuvable(s)`,
  );
  d.logger?.info("capture consolidée", { capture: c.id, affirmations: ids.length, citationsRejetees: etat.citationsRejetees });
  if (d.notifier) {
    try {
      await d.notifier(messageEquipe(c, ids.length, etat.citationsRejetees, d.adminUrl));
    } catch (e) {
      d.logger?.error("équipe non prévenue", { erreur: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ...etat, ids };
}

/** Le message à l'équipe : la source et le nombre de brouillons, jamais le profil de l'émetteur. */
export function messageEquipe(c: Pick<CaptureRow, "sourceType" | "auteurNom" | "auteurIdentifiant">, n: number, rejetees: number, adminUrl?: string): string {
  const auteur = c.auteurNom || c.auteurIdentifiant || "auteur inconnu";
  const ecartees = rejetees ? `, ${rejetees} écartée${rejetees > 1 ? "s" : ""} (citation introuvable)` : "";
  const ou = adminUrl ? `À relire : ${adminUrl.replace(/\/$/, "")}/admin` : "À relire : pnpm argu:prod lister";
  return `🗂 Capture analysée (${c.sourceType}, ${auteur}) : ${n} affirmation${n > 1 ? "s" : ""} en brouillon${ecartees}.\n${ou}`;
}

/** Toute la consolidation d'une capture, sans Mastra (scripts, tests). */
export async function consolider(d: ConsolidationDeps, captureId: string, opts: { relance?: boolean } = {}) {
  try {
    let etat = await preparer(d, captureId, opts);
    etat = await analyser(d, etat);
    etat = await rapprocher(d, etat);
    etat = await evaluer(d, etat);
    return await regrouperEtEnregistrer(d, etat);
  } catch (e) {
    await marquerErreur(d, captureId, e);
    throw e;
  }
}

/** Une panne (modèle, base) : la capture passe en erreur, avec le message, pour être relancée. */
export async function marquerErreur(d: Pick<ConsolidationDeps, "store" | "logger">, captureId: string, e: unknown): Promise<void> {
  const message = e instanceof Error ? e.message : String(e);
  d.logger?.error("consolidation en échec", { capture: captureId, erreur: message });
  await d.store.majCapture(captureId, { statut: "erreur", erreur: message.slice(0, 500) }).catch(() => undefined);
}
