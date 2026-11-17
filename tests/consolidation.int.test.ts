/**
 * La consolidation de bout en bout sur Postgres réel (TEST_DATABASE_URL : ses tables sont
 * effacées), avec un analyseur, une recherche et des embeddings simulés. Le workflow Mastra est
 * lancé comme le fait POST /capture.
 */
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Analyseur, Evaluation, Extraction, ProfilBrut } from "../src/argu/analyse.js";
import { enregistrerCapture } from "../src/argu/capture.js";
import { consolider, type ConsolidationDeps } from "../src/argu/consolidation.js";
import { ArguStore } from "../src/argu/store.js";
import { EMBEDDING_DIMENSION } from "../src/config.js";

const DB = process.env.TEST_DATABASE_URL;
if (DB) process.env.DATABASE_URL = DB;

/** Vecteur déterministe : deux textes identiques ont une similarité de 1. */
const embed = (t: string) => {
  const h = createHash("sha256").update(t).digest();
  return Array.from({ length: EMBEDDING_DIMENSION }, (_, i) => (h[i % h.length]! - 128) / 128);
};

const TEXTE = "La retraite à 60 ans coûte 80 milliards. Je suis artisan et je ne pourrai plus embaucher. C'est une fake news vérifiée.";

describe.skipIf(!DB)("consolidation (Postgres réel)", () => {
  let pool: Pool;
  let store: ArguStore;
  let messages: string[];
  let extraction: Extraction;
  let profil: ProfilBrut;
  let appels: string[];

  const analyseur: Analyseur = {
    modele: "simulé",
    async extraire() {
      appels.push("extraire");
      return extraction;
    },
    async profiler() {
      appels.push("profiler");
      return profil;
    },
    async evaluer(_c, affirmations): Promise<Evaluation[]> {
      appels.push("evaluer");
      return affirmations.map((a, i) => ({
        n: i + 1,
        appui_factuel: { note: 2, justification: "un chiffre non sourcé" },
        difficulte_reponse: { note: a.passages.length ? 2 : 5, justification: "selon les passages" },
        publics: [{ code: "retraites", justification: "parle des pensions" }, { code: "inconnu", justification: "x" }],
        familles: [{ code: "droite_liberale", justification: "registre du coût" }],
      }));
    },
  };

  const deps = (extra: Partial<ConsolidationDeps> = {}): ConsolidationDeps => ({
    store,
    analyseur,
    rechercher: async (requete) =>
      requete.includes("retraite")
        ? [{ id: "p1", score: 0.9, docId: "manual:livre-aec", title: "L'Avenir en commun", url: "", page: 4, section: "Garantir une retraite digne", category: "programme", corpus: "aec2027", provisional: false, text: "Rétablir la retraite à 60 ans." }]
        : [],
    embedder: { dimension: EMBEDDING_DIMENSION, embed: async (ts) => ts.map(embed) },
    notifier: async (m) => void messages.push(m),
    maxParJour: 50,
    seuilRegroupement: 0.8,
    seuilVerification: 0.85,
    adminUrl: "https://bot.exemple.fr",
    ...extra,
  });

  const capturer = async (texte = TEXTE, extra: Record<string, unknown> = {}) => {
    const r = await enregistrerCapture(
      { source_type: "x", url: `https://x.com/a/status/${Math.random().toString(36).slice(2)}`, texte, auteur: { nom: "Jean Artisan", identifiant: "@jean" }, ...extra },
      { capturePar: "u_test", canal: "cli" },
      { store },
    );
    if (!r.ok) throw new Error(r.message);
    return r.id;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB });
    await pool.query("DROP TABLE IF EXISTS aec_affirmations, aec_objections, aec_captures, aec_referentiels, aec_jetons CASCADE");
    store = new ArguStore(pool);
    await store.init();
  });
  afterAll(() => pool.end());
  beforeEach(async () => {
    await pool.query("DELETE FROM aec_captures; DELETE FROM aec_objections;");
    messages = [];
    appels = [];
    extraction = {
      affirmations: [
        { texte: "La retraite à 60 ans coûterait 80 milliards", citation: "La retraite à 60 ans coûte 80 milliards", types: ["critique"], position: "contre", theme: "retraites", registre: "cout_faisabilite" },
        { texte: "Hausse du SMIC et embauche", citation: "je ne pourrai plus embaucher", types: ["objection"], position: "contre", theme: "salaires_pouvoir_achat", registre: null },
        { texte: "Inventée par le modèle", citation: "le programme ruinera la France", types: ["critique"], position: "contre", theme: null, registre: null },
        { texte: "Accusation de fausse information", citation: "C'est une fake news vérifiée", types: ["fake_news"], position: "contre", theme: null, registre: null },
      ],
      auteur_type: "particulier",
      auteur_affiliation: null,
    };
    profil = {
      classe_sociale: { code: "artisan_commercant", justification: "il le dit", indice: "Je suis artisan", origine: "declare" },
      // Fondé sur le seul nom affiché : doit être refusé.
      orientation: { code: "droite_liberale", justification: "son nom", indice: "Jean Artisan", origine: "deduit" },
    };
  });

  it("une capture devient des brouillons vérifiés, et l'équipe est prévenue sans le profil", async () => {
    const id = await capturer();
    const r = await consolider(deps(), id);
    expect(r.arret).toBeNull();
    expect(r.ids).toHaveLength(3);
    expect(r.citationsRejetees).toBe(1);

    const affs = await store.affirmations({ captureId: id });
    expect(affs.every((a) => a.statut === "brouillon")).toBe(true);
    const retraite = affs.find((a) => a.theme === "retraites")!;
    expect(retraite).toMatchObject({
      citation: "La retraite à 60 ans coûte 80 milliards",
      publics: [{ code: "retraites", justification: "parle des pensions" }],
      familles: [{ code: "droite_liberale", justification: "registre du coût" }],
      passagesProgramme: [expect.objectContaining({ docId: "manual:livre-aec", section: "Garantir une retraite digne" })],
    });
    expect(retraite.force).toMatchObject({
      appui_factuel: { note: 2 }, difficulte_reponse: { note: 2 }, frequence: { note: 1 }, portee: { note: 1 },
    });
    // fake_news sans source de vérification : retiré, à vérifier.
    const fn = affs.find((a) => a.citation.includes("fake news"))!;
    expect(fn).toMatchObject({ types: [], aVerifier: true, verificationUrl: null });

    const c = await store.capture(id);
    expect(c).toMatchObject({ statut: "traitee", auteurType: "particulier", auteurAffiliation: null });
    expect(c!.emetteurProfil).toMatchObject({
      classe_sociale: { code: "artisan_commercant", indice: "Je suis artisan", origine: "declare" },
      orientation: { code: "indetermine", indice: null },
      modele: "simulé",
    });

    expect(messages).toEqual([
      "🗂 Capture analysée (x, Jean Artisan) : 3 affirmations en brouillon, 1 écartée (citation introuvable).\nÀ relire : https://bot.exemple.fr/admin",
    ]);
    expect(messages[0]).not.toMatch(/artisan_commercant|indetermine|droite/);
    const log = await pool.query("SELECT who, action, detail FROM aec_admin_log WHERE doc_id = $1", [id]);
    expect(log.rows[0]).toMatchObject({ who: "consolidation", action: "consolider", detail: "3 affirmation(s), 1 citation(s) introuvable(s)" });
  });

  it("propose les objections proches, et un debunk validé fonde l'étiquette fake_news", async () => {
    const texte = "La retraite à 60 ans coûterait 80 milliards";
    await pool.query("INSERT INTO aec_objections (intitule, embedding, statut) VALUES ($1, $2::vector, 'validee')", [
      "La retraite à 60 ans est infinançable", `[${embed(texte).join(",")}]`,
    ]);
    // Un debunk déjà validé, sur la même affirmation, avec sa source.
    const verif = await capturer("Vérification : C'est une fake news vérifiée.", { url: "https://verification.exemple.fr/1" });
    await consolider(deps(), verif);
    const debunk = (await store.affirmations({ captureId: verif })).find((a) => a.citation.includes("fake news"))!;
    await pool.query("UPDATE aec_affirmations SET types = '{debunk}', statut = 'validee' WHERE id = $1", [debunk.id]);

    const id = await capturer();
    await consolider(deps(), id);
    const affs = await store.affirmations({ captureId: id });
    expect(affs.find((a) => a.theme === "retraites")!.propositions).toEqual([
      { id: expect.any(String), intitule: "La retraite à 60 ans est infinançable", score: expect.closeTo(1, 5), rattachees: 0 },
    ]);
    expect(affs.find((a) => a.citation.includes("fake news"))).toMatchObject({
      types: ["fake_news"], aVerifier: false, verificationUrl: "https://verification.exemple.fr/1",
    });
  });

  it("plafond quotidien, lien seul, panne : rien n'est appelé pour rien, la capture reste relançable", async () => {
    const id = await capturer();
    expect((await consolider(deps({ maxParJour: 0 }), id)).arret).toBe("plafond quotidien atteint");
    expect(appels).toEqual([]);
    expect(await store.capturesEnAttente()).toEqual([id]);

    const lien = await capturer("https://exemple.fr/article");
    expect((await consolider(deps(), lien)).arret).toMatch(/lien seul/);
    expect(await store.capture(lien)).toMatchObject({ statut: "erreur" });
    expect(appels).toEqual([]);

    const enPanne = { ...analyseur, extraire: async () => { throw new Error("modèle indisponible"); } };
    await expect(consolider(deps({ analyseur: enPanne }), id)).rejects.toThrow("modèle indisponible");
    expect(await store.capture(id)).toMatchObject({ statut: "erreur", erreur: "modèle indisponible" });
    // Une panne se relance, pas un lien seul.
    expect(await store.capturesEnAttente()).toEqual([id]);
  });

  it("une relance remplace les brouillons, garde les décisions et le profil corrigés par l'équipe", async () => {
    const id = await capturer();
    await consolider(deps(), id);
    expect((await consolider(deps(), id)).arret).toBe("déjà consolidée");

    const [premiere] = await store.affirmations({ captureId: id });
    await store.deciderAffirmation(premiere!.id.slice(0, 8), "validee", "u_relecteur");
    const c = (await store.capture(id))!;
    const corrige = { ...c.emetteurProfil!, orientation: { code: "extreme_droite", justification: "corrigé", indice: null, origine: "corrige" as const } };
    await store.enregistrerProfilEmetteur(id, corrige);

    await consolider(deps(), id, { relance: true });
    const affs = await store.affirmations({ captureId: id });
    expect(affs.filter((a) => a.statut === "validee").map((a) => a.id)).toEqual([premiere!.id]);
    expect(affs.filter((a) => a.statut === "brouillon")).toHaveLength(3);
    expect((await store.capture(id))!.emetteurProfil!.orientation.origine).toBe("corrige");
    const log = await pool.query("SELECT who FROM aec_admin_log WHERE action = 'valider_affirmation' AND doc_id = $1", [premiere!.id]);
    expect(log.rows).toEqual([{ who: "u_relecteur" }]);
  });

  it("le workflow Mastra, lancé comme par POST /capture, produit les brouillons", async () => {
    const { setConsolidationDeps } = await import("../src/argu/deps.js");
    setConsolidationDeps(deps());
    try {
      const { mastra } = await import("../src/mastra/index.js");
      const { lanceur } = await import("../src/mastra/routes/capture.js");
      const id = await capturer();
      const res = await lanceur(mastra)(id);
      expect(res.status).toBe("success");
      expect((await store.affirmations({ captureId: id })).length).toBe(3);

      // Une panne dans une étape : le run échoue, la capture passe en erreur.
      setConsolidationDeps(deps({ analyseur: { ...analyseur, profiler: async () => { throw new Error("hors service"); } } }));
      const id2 = await capturer("Un autre texte sur la retraite à 60 ans coûte 80 milliards.");
      expect((await lanceur(mastra)(id2)).status).toBe("failed");
      expect(await store.capture(id2)).toMatchObject({ statut: "erreur", erreur: "hors service" });
    } finally {
      setConsolidationDeps(undefined);
    }
  });
});
