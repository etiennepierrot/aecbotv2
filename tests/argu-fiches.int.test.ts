/**
 * Import des fiches d'objections en brouillon, contre une vraie base Postgres + pgvector
 * (TEST_DATABASE_URL : ses tables sont effacées).
 */
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { importerFiches, type FicheBrouillon } from "../src/argu/fiches.js";
import { ArguStore } from "../src/argu/store.js";

const DB = process.env.TEST_DATABASE_URL;

const fiche = (intitule: string, theme: string | null = "retraites"): FicheBrouillon => ({
  intitule,
  reformulations: ["On n'a pas les moyens"],
  theme,
  reponse_courte: "Réponse courte.",
  reponse_detaillee: "Réponse détaillée.",
  points_appui: [{ type: "presse", titre: "Article", url: "https://exemple.fr/article" }],
});

describe.skipIf(!DB)("import des fiches d'objections", () => {
  let pool: Pool;
  let store: ArguStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB });
    await pool.query(
      "DROP TABLE IF EXISTS aec_affirmations, aec_objections, aec_captures, aec_referentiels, aec_jetons CASCADE",
    );
    store = new ArguStore(pool);
    await store.init();
  });
  afterAll(() => pool.end());
  beforeEach(() => pool.query("DELETE FROM aec_objections"));

  it("ajoute en brouillon, puis laisse en place au second import", async () => {
    const r1 = await importerFiches(store, [fiche("La retraite à 60 ans est infinançable"), fiche("Antisémitisme", null)]);
    expect(r1).toEqual({ ajoutees: ["La retraite à 60 ans est infinançable", "Antisémitisme"], existantes: [] });

    const { rows } = await pool.query("SELECT intitule, statut, theme, points_appui FROM aec_objections ORDER BY intitule");
    expect(rows.map((r) => r.statut)).toEqual(["brouillon", "brouillon"]);
    expect(rows[0].theme).toBeNull();
    expect(rows[1].points_appui).toEqual([{ type: "presse", titre: "Article", url: "https://exemple.fr/article" }]);

    const r2 = await importerFiches(store, [fiche("la retraite à 60 ans est INFINANÇABLE")]);
    expect(r2).toEqual({ ajoutees: [], existantes: ["la retraite à 60 ans est INFINANÇABLE"] });
  });

  it("ne touche jamais une objection déjà validée par l'équipe", async () => {
    await pool.query(
      `INSERT INTO aec_objections (intitule, reponse_courte, statut) VALUES ('La retraite à 60 ans est infinançable', 'Version de l''équipe', 'validee')`,
    );
    await importerFiches(store, [fiche("La retraite à 60 ans est infinançable")]);
    const { rows } = await pool.query("SELECT reponse_courte, statut FROM aec_objections");
    expect(rows).toEqual([{ reponse_courte: "Version de l'équipe", statut: "validee" }]);
  });

  it("refuse tout le lot si un thème est inconnu", async () => {
    await expect(importerFiches(store, [fiche("A"), fiche("B", "geopolitique")])).rejects.toThrow(/geopolitique/);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM aec_objections");
    expect(rows[0].n).toBe(0);
  });
});
