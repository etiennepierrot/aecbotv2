/**
 * POST /capture et GET /capture/config de bout en bout, à travers Hono comme sur le serveur
 * Mastra, contre une vraie base Postgres + pgvector (TEST_DATABASE_URL : ses tables sont effacées).
 */
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { creerJeton } from "../src/argu/jetons.js";
import { SELECTEURS } from "../src/argu/selecteurs.js";
import { ArguStore } from "../src/argu/store.js";
import { captureConfigHandler, captureHandler } from "../src/mastra/routes/capture.js";

const DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB)("route /capture", () => {
  let pool: Pool;
  let store: ArguStore;
  let app: Hono;
  let jeton: string;
  const lancees: string[] = [];
  const maxParJeton = 3;

  const post = (body: unknown, auth: string | null = `Bearer ${jeton}`) =>
    app.request("/capture", {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  const capture = (n: number) => ({
    source_type: "x",
    url: `https://x.com/compte/status/${n}?s=20`,
    texte: `Le programme coûterait trop cher (${n}).`,
    auteur: { nom: "Compte", identifiant: "@compte" },
    publie_le: "2026-11-16T18:42:00Z",
    extras: { fil: [] },
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB });
    await pool.query(
      "DROP TABLE IF EXISTS aec_affirmations, aec_objections, aec_captures, aec_referentiels, aec_jetons CASCADE",
    );
    store = new ArguStore(pool);
    await store.init();
    await store.init(); // idempotent
    const deps = () => ({ store, maxParJeton, lancerConsolidation: async (id: string) => void lancees.push(id) });
    app = new Hono();
    app.post("/capture", captureHandler(deps));
    app.get("/capture/config", captureConfigHandler(deps));
  });
  afterAll(() => pool.end());
  beforeEach(async () => {
    await pool.query("DELETE FROM aec_captures; DELETE FROM aec_jetons;");
    lancees.length = 0;
    jeton = await creerJeton(store, "u_membre");
  });

  it("201 puis 200 pour le même contenu, sans relancer la consolidation", async () => {
    const r1 = await post(capture(1));
    expect(r1.status).toBe(201);
    const b1 = (await r1.json()) as { id: string; statut: string };
    expect(b1.statut).toBe("recue");

    const { rows } = await pool.query("SELECT * FROM aec_captures WHERE id = $1", [b1.id]);
    expect(rows[0]).toMatchObject({
      source_type: "x", url: "https://x.com/compte/status/1", auteur_identifiant: "@compte",
      capture_par: "u_membre", canal: "extension", statut: "recue", extras: { fil: [] },
    });

    const r2 = await post({ ...capture(1), url: "https://twitter.com/compte/status/1" });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ id: b1.id, statut: "doublon" });
    expect(lancees).toEqual([b1.id]);
  });

  it("401 sans jeton, avec un jeton inconnu ou révoqué", async () => {
    expect((await post(capture(1), null)).status).toBe(401);
    expect((await post(capture(1), "Bearer aec_inconnu")).status).toBe(401);
    expect(await store.revoquerJetons("u_membre")).toBe(1);
    expect((await post(capture(1))).status).toBe(401);
    expect((await app.request("/capture/config", { headers: { authorization: `Bearer ${jeton}` } })).status).toBe(401);
  });

  it("un nouveau jeton remplace l'ancien", async () => {
    const ancien = jeton;
    jeton = await creerJeton(store, "u_membre");
    expect((await post(capture(1), `Bearer ${ancien}`)).status).toBe(401);
    expect((await post(capture(1))).status).toBe(201);
  });

  it("422 avec le champ en cause, 413 pour un texte trop long", async () => {
    const r = await post({ ...capture(1), url: "http://x.com/a" });
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ champ: "url" });
    expect((await post("{pas du json")).status).toBe(422);
    expect((await post({ ...capture(1), texte: "a".repeat(50_001) })).status).toBe(413);
  });

  it("429 au-delà du quota du jeton sur 24 h", async () => {
    for (let n = 1; n <= maxParJeton; n++) expect((await post(capture(n))).status).toBe(201);
    expect((await post(capture(99))).status).toBe(429);
    // Les captures plus anciennes que 24 h ne comptent plus.
    await pool.query("UPDATE aec_captures SET cree_le = now() - interval '25 hours'");
    expect((await post(capture(99))).status).toBe(201);
  });

  it("GET /capture/config renvoie les sélecteurs avec un jeton valable", async () => {
    const r = await app.request("/capture/config", { headers: { authorization: `Bearer ${jeton}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(JSON.parse(JSON.stringify(SELECTEURS)));
  });

  it("supprime une capture ou toutes celles d'un auteur, avec leurs affirmations et le profil de l'émetteur", async () => {
    const ids: string[] = [];
    for (const n of [1, 2]) ids.push(((await (await post(capture(n))).json()) as { id: string }).id);
    const autre = ((await (await post({ ...capture(3), auteur: { identifiant: "@autre" } })).json()) as { id: string }).id;
    await pool.query(`INSERT INTO aec_affirmations (capture_id, texte, citation) VALUES ($1, 'coût', 'trop cher')`, [ids[0]]);
    const trait = { code: "indetermine", justification: "rien dans la capture", indice: null, origine: "deduit" as const };
    const profil = { classe_sociale: trait, orientation: trait, modele: "test", evalue_le: "2026-11-17T10:00:00Z" };
    expect(await store.enregistrerProfilEmetteur(ids[1]!, profil)).toBe(true);
    expect((await store.capture(ids[1]!))?.emetteurProfil).toEqual(profil);

    expect(await store.supprimerAuteur("@compte")).toBe(2);
    expect((await pool.query("SELECT count(*)::int AS n FROM aec_affirmations")).rows[0].n).toBe(0);
    // Le profil de l'émetteur disparaît avec ses captures : rien ne reste rattaché à l'auteur.
    expect((await pool.query("SELECT count(*)::int AS n FROM aec_captures WHERE emetteur_profil IS NOT NULL")).rows[0].n).toBe(0);
    expect(await store.capture(autre)).toMatchObject({ id: autre, auteurIdentifiant: "@autre" });
    expect(await store.supprimerCapture(autre)).toBe(true);
    expect(await store.capture(autre)).toBeUndefined();
  });

  it("référentiel des catégories livré au départ", async () => {
    expect((await store.referentiel("categorie")).map((r) => r.code)).toEqual([
      "argument", "critique", "objection", "debunk", "fake_news",
    ]);
  });
});
