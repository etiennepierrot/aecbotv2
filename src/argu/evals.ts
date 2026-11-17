import type { RetrievedPassage } from "../aec/types.js";
import type { Analyseur, CaptureAnalysee, ReferentielsActifs } from "./analyse.js";
import { normaliserPourComparer } from "./citations.js";
import { brouillonsVerifies } from "./consolidation.js";
import { regleFakeNews, verifierProfil } from "./regles.js";

/**
 * Évals de la consolidation (spec, « Évals et tests ») : un jeu de captures annotées à la main,
 * passé au modèle sans toucher à la base des captures. Les seuils sont des points de départ, à
 * recaler après la première passe. Les publics ne sont pas notés : sans retour de terrain, il
 * n'existe pas de réponse de référence.
 */

export interface AffirmationAttendue {
  citation: string;
  types: string[];
  position: "pour" | "contre" | "neutre";
}

export interface EvalCapture {
  id: string;
  capture: {
    source_type: string;
    url?: string;
    texte: string;
    auteur?: { nom?: string; identifiant?: string };
    extras?: Record<string, unknown>;
  };
  attendu: {
    affirmations: AffirmationAttendue[];
    /** Codes attendus, « indetermine » compris. Absent : trait non noté. */
    emetteur?: { classe_sociale?: string; orientation?: string };
  };
}

/** Le résultat d'une passe sur une capture, après les vérifications du code. */
export interface Passe {
  citationsBrutes: number;
  citationsIntrouvables: number;
  /** Étiquettes fake_news proposées par le modèle sans source de vérification (avant la règle). */
  fakeNewsSansPreuveBrut: number;
  /** Après la règle : doit toujours valoir 0. */
  fakeNewsSansPreuve: number;
  affirmations: { citation: string; types: string[]; position: string; force: Record<string, number> }[];
  emetteur: { classe_sociale: string; orientation: string };
}

export const capturePourEval = (c: EvalCapture["capture"]): CaptureAnalysee => ({
  sourceType: c.source_type, texte: c.texte, url: c.url ?? null, auteurNom: c.auteur?.nom ?? null,
  auteurIdentifiant: c.auteur?.identifiant ?? null, extras: c.extras ?? {},
});

/** Une passe : les mêmes appels et les mêmes vérifications que le workflow, sans base de captures. */
export async function passer(
  item: EvalCapture,
  analyseur: Analyseur,
  r: ReferentielsActifs,
  rechercher: (requete: string) => Promise<RetrievedPassage[]>,
): Promise<Passe> {
  const c = capturePourEval(item.capture);
  const [extraction, profilBrut] = await Promise.all([analyseur.extraire(c, r), analyseur.profiler(c, r)]);
  const { brouillons, rejetees } = brouillonsVerifies(extraction, c.texte, r);
  const verification = typeof c.extras?.verification_url === "string" ? c.extras.verification_url : c.sourceType === "rss" ? c.url ?? null : null;
  const passages = await Promise.all(brouillons.map((b) => rechercher(b.texte)));
  const evaluations = await analyseur.evaluer(
    c,
    brouillons.map((b, i) => ({ texte: b.texte, passages: (passages[i] ?? []).slice(0, 5).map((p) => ({ titre: p.title, extrait: p.text.slice(0, 600) })) })),
    r,
  );
  const profil = verifierProfil(profilBrut, { classes: r.classes.map((x) => x.code), familles: r.familles.map((x) => x.code) }, {
    texte: c.texte, auteurNom: c.auteurNom, auteurIdentifiant: c.auteurIdentifiant,
    bio: typeof c.extras?.bio === "string" ? c.extras.bio : null,
  });
  const affirmations = brouillons.map((b, i) => {
    const e = evaluations.find((x) => x.n === i + 1);
    return {
      citation: b.citation,
      types: regleFakeNews(b.types, verification).types,
      position: b.position,
      force: (e ? { appui_factuel: e.appui_factuel.note, difficulte_reponse: e.difficulte_reponse.note } : {}) as Record<string, number>,
    };
  });
  return {
    citationsBrutes: extraction.affirmations.length,
    citationsIntrouvables: rejetees,
    fakeNewsSansPreuveBrut: verification ? 0 : brouillons.filter((b) => b.types.includes("fake_news")).length,
    fakeNewsSansPreuve: verification ? 0 : affirmations.filter((a) => a.types.includes("fake_news")).length,
    affirmations,
    emetteur: { classe_sociale: profil.classe_sociale.code, orientation: profil.orientation.code },
  };
}

// --- Métriques ---------------------------------------------------------------------------------

const mots = (s: string) => new Set(normaliserPourComparer(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((m) => m.length > 2));

/** Deux citations désignent le même passage : l'une contient l'autre, ou elles partagent la moitié de leurs mots. */
export function memesCitations(a: string, b: string): boolean {
  const na = normaliserPourComparer(a).toLowerCase();
  const nb = normaliserPourComparer(b).toLowerCase();
  if (na.includes(nb) || nb.includes(na)) return true;
  const [ma, mb] = [mots(a), mots(b)];
  const communs = [...ma].filter((m) => mb.has(m)).length;
  const union = new Set([...ma, ...mb]).size;
  return union > 0 && communs / union >= 0.5;
}

/** Appariement glouton attendu → obtenu, dans l'ordre. */
export function apparier<T extends { citation: string }>(attendues: AffirmationAttendue[], obtenues: T[]) {
  const libres = new Set(obtenues.map((_, i) => i));
  const paires: [AffirmationAttendue, T][] = [];
  for (const a of attendues) {
    const i = [...libres].find((j) => memesCitations(a.citation, obtenues[j]!.citation));
    if (i === undefined) continue;
    libres.delete(i);
    paires.push([a, obtenues[i]!]);
  }
  return { paires, inventees: libres.size };
}

export interface Rapport {
  captures: number;
  citationsRetrouvees: number;
  rappel: number;
  inventees: number;
  f1Types: number;
  accordPosition: number;
  fakeNewsSansPreuve: number;
  fakeNewsSansPreuveBrut: number;
  accordEmetteur: number | null;
  tauxIndetermine: number;
  /** Écart maximal d'une note de force entre passes, sur une même affirmation (null : une seule passe). */
  ecartForceMax: number | null;
  /** Part des traits de l'émetteur qui gardent le même code dans au moins 2 passes sur 3. */
  stabiliteEmetteur: number | null;
  verdict: { critere: string; valeur: string; seuil: string; ok: boolean }[];
}

export function resumer(items: EvalCapture[], passes: Passe[][]): Rapport {
  let attendues = 0, retrouvees = 0, inventees = 0, positionsOk = 0, paires = 0;
  let vp = 0, fp = 0, fn = 0, brutes = 0, introuvables = 0, fnPreuve = 0, fnPreuveBrut = 0;
  let traits = 0, traitsOk = 0, indet = 0, traitsTotal = 0, ecartMax: number | null = null, stables = 0, traitsStabilite = 0;

  items.forEach((item, k) => {
    const lesPasses = passes[k]!;
    const p = lesPasses[0]!;
    for (const x of lesPasses) {
      brutes += x.citationsBrutes;
      introuvables += x.citationsIntrouvables;
      fnPreuve += x.fakeNewsSansPreuve;
      fnPreuveBrut += x.fakeNewsSansPreuveBrut;
    }
    const app = apparier(item.attendu.affirmations, p.affirmations);
    attendues += item.attendu.affirmations.length;
    retrouvees += app.paires.length;
    inventees += app.inventees;
    for (const [a, o] of app.paires) {
      paires++;
      if (a.position === o.position) positionsOk++;
      const [ta, to] = [new Set(a.types), new Set(o.types)];
      vp += [...to].filter((t) => ta.has(t)).length;
      fp += [...to].filter((t) => !ta.has(t)).length;
      fn += [...ta].filter((t) => !to.has(t)).length;
    }
    for (const trait of ["classe_sociale", "orientation"] as const) {
      traitsTotal++;
      if (p.emetteur[trait] === "indetermine") indet++;
      const attendu = item.attendu.emetteur?.[trait];
      if (attendu) {
        traits++;
        if (p.emetteur[trait] === attendu) traitsOk++;
      }
      if (lesPasses.length > 1) {
        traitsStabilite++;
        const codes = lesPasses.map((x) => x.emetteur[trait]);
        const max = Math.max(...codes.map((c) => codes.filter((d) => d === c).length));
        if (max >= Math.min(2, lesPasses.length)) stables++;
      }
    }
    // Stabilité de la force : la même affirmation attendue, retrouvée dans chaque passe.
    if (lesPasses.length > 1) {
      for (const a of item.attendu.affirmations) {
        const notes = lesPasses
          .map((x) => apparier([a], x.affirmations).paires[0]?.[1].force)
          .filter((f): f is Record<string, number> => !!f);
        if (notes.length < 2) continue;
        for (const critere of ["appui_factuel", "difficulte_reponse"]) {
          const v = notes.map((n) => n[critere]).filter((x): x is number => typeof x === "number");
          if (v.length > 1) ecartMax = Math.max(ecartMax ?? 0, Math.max(...v) - Math.min(...v));
        }
      }
    }
  });

  const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);
  const precision = ratio(vp, vp + fp), rappelTypes = ratio(vp, vp + fn);
  const f1 = precision + rappelTypes === 0 ? 0 : (2 * precision * rappelTypes) / (precision + rappelTypes);
  const r: Omit<Rapport, "verdict"> = {
    captures: items.length,
    citationsRetrouvees: ratio(brutes - introuvables, brutes),
    rappel: ratio(retrouvees, attendues),
    inventees,
    f1Types: f1,
    accordPosition: ratio(positionsOk, paires),
    fakeNewsSansPreuve: fnPreuve,
    fakeNewsSansPreuveBrut: fnPreuveBrut,
    accordEmetteur: traits ? traitsOk / traits : null,
    tauxIndetermine: ratio(indet, traitsTotal),
    ecartForceMax: ecartMax,
    stabiliteEmetteur: traitsStabilite ? stables / traitsStabilite : null,
  };
  const pct = (x: number) => `${Math.round(x * 100)} %`;
  const verdict = [
    { critere: "Extraction (rappel)", valeur: r.rappel.toFixed(2), seuil: "≥ 0,8", ok: r.rappel >= 0.8 },
    { critere: "Classement (F1 types)", valeur: r.f1Types.toFixed(2), seuil: "≥ 0,8", ok: r.f1Types >= 0.8 },
    { critere: "Position", valeur: r.accordPosition.toFixed(2), seuil: "≥ 0,9", ok: r.accordPosition >= 0.9 },
    { critere: "fake_news sans preuve", valeur: String(r.fakeNewsSansPreuve), seuil: "0", ok: r.fakeNewsSansPreuve === 0 },
    ...(r.accordEmetteur === null ? [] : [{ critere: "Émetteur (accord)", valeur: r.accordEmetteur.toFixed(2), seuil: "≥ 0,7", ok: r.accordEmetteur >= 0.7 }]),
    ...(r.ecartForceMax === null ? [] : [{ critere: "Stabilité de la force", valeur: `${r.ecartForceMax} point(s)`, seuil: "≤ 1", ok: r.ecartForceMax <= 1 }]),
    ...(r.stabiliteEmetteur === null ? [] : [{ critere: "Stabilité de l'émetteur", valeur: pct(r.stabiliteEmetteur), seuil: "100 % (2 passes sur 3)", ok: r.stabiliteEmetteur === 1 }]),
  ];
  return { ...r, verdict };
}
