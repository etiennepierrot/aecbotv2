/**
 * Test d'intégration du workflow ingest, contre une vraie base Postgres + pgvector
 * dédiée (TEST_DATABASE_URL : ses tables sont effacées). Le site WordPress et Mistral sont simulés.
 *   pnpm db:up && pnpm db:test && TEST_DATABASE_URL=postgresql://aecbot:aecbot@localhost:5432/aecbot_test pnpm test
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSION, PASSAGES_INDEX } from "../src/config.js";
import type { Embedder } from "../src/corpus/embed.js";
import type { SourceItem } from "../src/corpus/types.js";
import { makePdf } from "./helpers/pdf.js";

const DB = process.env.TEST_DATABASE_URL;
// Jamais la base de dev : les tables sont supprimées au début du test.
if (DB) process.env.DATABASE_URL = DB;

/** Vecteur déterministe tiré du texte : assez pour vérifier ce qui est stocké. */
class FakeEmbedder implements Embedder {
  readonly dimension = EMBEDDING_DIMENSION;
  calls = 0;
  async embed(texts: string[]) {
    this.calls += texts.length;
    return texts.map((t) => {
      const h = createHash("sha256").update(t).digest();
      return Array.from({ length: this.dimension }, (_, i) => (h[i % h.length]! - 128) / 128);
    });
  }
}

class FakeSite {
  items = new Map<string, SourceItem>();
  files = new Map<string, Uint8Array>();
  async listItems() {
    return [...this.items.values()];
  }
  async download(url: string) {
    const f = this.files.get(url);
    if (!f) throw new Error(`404 ${url}`);
    return f;
  }
  addPdf(id: number, title: string, path: string, modified: string, pages: string[][]) {
    const url = `https://melenchon2027.fr/wp-content/uploads/${path}`;
    this.items.set(`wp:media:${id}`, { id: `wp:media:${id}`, origin: "wordpress", kind: "pdf", title, url, modified });
    this.files.set(url, makePdf(pages));
  }
}

const filler = (topic: string) =>
  Array.from({ length: 12 }, (_, i) => `Mesure ${i + 1} : nous proposons d'agir sur ${topic} pour toutes et tous.`);

describe.skipIf(!DB)("workflow ingest (Postgres réel)", () => {
  const site = new FakeSite();
  const embedder = new FakeEmbedder();
  let mastra: typeof import("../src/mastra/index.js").mastra;
  let store: import("../src/corpus/store.js").CorpusStore;
  let pool: import("pg").Pool;

  const scan = async (extra: Record<string, unknown> = {}) => {
    const run = await mastra.getWorkflow("ingest").createRun();
    const res = await run.start({ inputData: { mode: "scan", ...extra } as never });
    if (res.status !== "success") throw new Error(`workflow ${res.status}: ${JSON.stringify((res as { error?: unknown }).error)}`);
    return res.result;
  };

  beforeAll(async () => {
    process.env.MISTRAL_API_KEY ??= "test";
    process.env.INGEST_CRON = "";
    const deps = await import("../src/corpus/deps.js");
    const { CorpusStore } = await import("../src/corpus/store.js");
    pool = deps.pgVector().pool;
    await pool.query(`DROP TABLE IF EXISTS aec_documents; DROP TABLE IF EXISTS ${PASSAGES_INDEX};`);
    store = new CorpusStore(deps.pgVector(), EMBEDDING_DIMENSION);
    deps.setIngestDeps({ source: site, embedder, store });
    ({ mastra } = await import("../src/mastra/index.js"));

    site.addPdf(15699, "PROGRAMME SITE 2025", "2025/02/A5-PROGRAMME-SITE.pdf", "2025-02-18T10:00:00.000Z", [
      filler("les salaires"),
      ["Retraite : retablir le droit a la retraite a 60 ans apres 40 annuites.", ...filler("les retraites")],
    ]);
    site.addPdf(12361, "Livret_UP_13_SANTE_web-ok", "2024/02/Livret_UP_13_SANTE_web-ok.pdf", "2024-02-02T10:00:00.000Z", [
      filler("l'hopital public"),
    ]);
    // Même PDF téléversé deux fois : le plus récent (13782) doit être gardé.
    site.addPdf(13769, "Plan_UP_QUALIF_web", "2024/02/Plan_UP_QUALIF_web.pdf", "2024-02-22T10:00:00.000Z", [filler("la qualification")]);
    site.addPdf(13782, "Plan_UP_QUALIF_web", "2024/02/Plan_UP_QUALIF_web-1.pdf", "2024-02-22T10:00:00.000Z", [filler("la qualification")]);
    site.addPdf(25528, "DOSSIER DE PRESSE_0810", "2026/10/DOSSIER-DE-PRESSE_0810.pdf", "2026-10-09T10:00:00.000Z", [filler("la presse")]);
    site.addPdf(19642, "PROGRAMME-FRONT-POPULAIRE", "2026/04/PROGRAMME-FRONT-POPULAIRE.pdf", "2026-04-21T10:00:00.000Z", [filler("le NFP")]);
    site.addPdf(22111, "A4_PROGRAMME_ABREGE_FALC_web", "2026/05/A4_PROGRAMME_ABREGE_FALC_web.pdf", "2026-05-12T10:00:00.000Z", [["  "], ["."]]);
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  it("premier scan : indexe le corpus et écarte ce qui doit l'être", async () => {
    const r = await scan();
    const byId = Object.fromEntries(r.documents.map((d) => [d.id, d]));

    expect(byId["wp:media:15699"]).toMatchObject({ status: "indexé", category: "programme" });
    expect(byId["wp:media:12361"]).toMatchObject({ status: "indexé", category: "livret" });
    expect(byId["wp:media:13782"]).toMatchObject({ status: "indexé", category: "plan" });
    expect(byId["wp:media:13769"]).toMatchObject({ status: "écarté", detail: "Doublon exact de wp:media:13782" });
    expect(byId["wp:media:25528"]).toMatchObject({ status: "écarté", category: "autre" });
    expect(byId["wp:media:19642"]).toMatchObject({ status: "écarté", category: "archive" });
    expect(byId["wp:media:22111"]).toMatchObject({ status: "écarté", detail: "Extraction non exploitable" });
    expect(r).toMatchObject({ indexed: 3, excluded: 4, errors: 0, unchanged: 0 });

    const { rows } = await pool.query(
      `SELECT metadata FROM ${PASSAGES_INDEX} WHERE metadata->>'docId' = 'wp:media:15699' AND metadata->>'text' LIKE '%60 ans%'`,
    );
    expect(rows[0]?.metadata).toMatchObject({ page: 2, category: "programme", provisional: true, corpus: "aec2027" });
    // Rien d'indexé pour les documents écartés.
    const excluded = await pool.query(
      `SELECT count(*)::int n FROM ${PASSAGES_INDEX} WHERE metadata->>'docId' IN ('wp:media:13769','wp:media:25528','wp:media:19642')`,
    );
    expect(excluded.rows[0].n).toBe(0);
  });

  it("deuxième scan sans changement : ne retélécharge ni ne réindexe rien", async () => {
    const before = embedder.calls;
    const r = await scan();
    expect(r.documents).toHaveLength(0);
    expect(r.unchanged).toBe(7);
    expect(embedder.calls).toBe(before);
  });

  it("document modifié : ses anciens passages sont remplacés", async () => {
    site.addPdf(12361, "Livret_UP_13_SANTE_web-ok", "2024/02/Livret_UP_13_SANTE_web-ok.pdf", "2026-11-01T10:00:00.000Z", [
      ["Nouvelle version du livret sante.", ...filler("les centres de sante")],
    ]);
    const r = await scan();
    expect(r.documents.map((d) => d.id)).toEqual(["wp:media:12361"]);
    const { rows } = await pool.query(
      `SELECT metadata->>'text' AS text FROM ${PASSAGES_INDEX} WHERE metadata->>'docId' = 'wp:media:12361'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => !x.text.includes("hopital public"))).toBe(true);
  });

  it("document disparu du site : retiré avec ses passages", async () => {
    // 8 documents connus en ajoutant un neuvième, pour rester sous le seuil de 20 %.
    site.addPdf(12350, "Livret_UP_05_DEFENSE_web-ok", "2024/02/Livret_UP_05_DEFENSE_web-ok.pdf", "2024-02-02T10:00:00.000Z", [filler("la defense")]);
    await scan();
    site.items.delete("wp:media:12350");
    const r = await scan();
    expect(r.removed).toEqual(["wp:media:12350"]);
    expect((await store.listDocuments()).some((d) => d.id === "wp:media:12350")).toBe(false);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM ${PASSAGES_INDEX} WHERE metadata->>'docId' = 'wp:media:12350'`);
    expect(rows[0].n).toBe(0);
  });

  it("garde-fou : refuse de vider l'index si le site renvoie soudain beaucoup moins de documents", async () => {
    const saved = new Map(site.items);
    for (const id of [...site.items.keys()].slice(0, 4)) site.items.delete(id);
    const r = await scan();
    expect(r.removed).toEqual([]);
    expect(r.warnings[0]).toMatch(/retrait annulé/);
    expect((await store.listDocuments()).length).toBe(7);
    site.items = saved;
  });

  it("une erreur de téléchargement n'arrête pas le scan et sera retentée", async () => {
    site.items.set("wp:media:30000", {
      id: "wp:media:30000", origin: "wordpress", kind: "pdf", title: "Livret_UP_99_CASSE",
      url: "https://melenchon2027.fr/wp-content/uploads/2024/02/absent.pdf", modified: "2024-02-02T10:00:00.000Z",
    });
    const r = await scan();
    expect(r.documents).toEqual([expect.objectContaining({ id: "wp:media:30000", status: "erreur" })]);
    expect((await store.listDocuments()).some((d) => d.id === "wp:media:30000")).toBe(false);
    site.items.delete("wp:media:30000");
  });

  it("recherche : retrouve le passage avec sa page, filtrée par édition", async () => {
    const deps = await import("../src/corpus/deps.js");
    deps.setRetrievalDeps({ embedder, vector: deps.pgVector() });
    const { searchPassages } = await import("../src/aec/search.js");
    const { rows } = await pool.query(
      `SELECT metadata->>'text' AS text FROM ${PASSAGES_INDEX} WHERE metadata->>'text' LIKE '%retraite a 60 ans%' LIMIT 1`,
    );
    // L'embedder simulé n'est pas sémantique : on cherche le texte exact du passage.
    const hits = await searchPassages({ requete: rows[0].text, topK: 3 });
    expect(hits[0]).toMatchObject({
      docId: "wp:media:15699", page: 2, category: "programme", provisional: true, corpus: "aec2027",
      url: "https://melenchon2027.fr/wp-content/uploads/2025/02/A5-PROGRAMME-SITE.pdf",
    });
    expect(hits[0]!.score).toBeGreaterThan(0.99);
    // Le livret Santé « UP » est de la campagne 2022 : seul lui sort quand on filtre sur 2022.
    const old = await searchPassages({ requete: rows[0].text, edition: "aec2022" });
    expect(old.length).toBeGreaterThan(0);
    expect(old.every((h) => h.corpus === "aec2022" && h.docId !== "wp:media:15699")).toBe(true);
    expect((await searchPassages({ requete: rows[0].text, categories: ["livret"] })).every((h) => h.category === "livret")).toBe(true);
  });

  it("recherche : élargit chaque passage à sa page entière", async () => {
    const deps = await import("../src/corpus/deps.js");
    deps.setRetrievalDeps({ embedder, vector: deps.pgVector(), pageChunks: deps.pageChunksFrom(deps.pgVector()) });
    const { searchPassages } = await import("../src/aec/search.js");
    // Une publication 2026 avec une page longue, découpée en plusieurs passages.
    site.addPdf(26000, "Plan salaires", "2026/11/plan-salaires.pdf", "2026-11-10T10:00:00.000Z", [
      [...filler("les salaires"), ...filler("les conventions collectives"), ...filler("le SMIC a 1600 euros"), ...filler("les primes")],
    ]);
    await scan();
    const { rows } = await pool.query(
      `SELECT metadata->>'text' AS text FROM ${PASSAGES_INDEX} WHERE metadata->>'docId' = 'wp:media:26000' AND metadata->>'page' = '1'`,
    );
    expect(rows.length).toBeGreaterThan(1);
    const hits = await searchPassages({ requete: rows[0].text, edition: "aec2027" });
    const page = hits.filter((h) => h.docId === "wp:media:26000");
    expect(page).toHaveLength(1);
    expect(page[0]!.id).toBe("wp:media:26000#p1");
    // Le texte rendu contient tous les passages de la page, pas seulement celui trouvé.
    for (const r of rows) expect(page[0]!.text).toContain(r.text.slice(-40));
    expect(page[0]!.text).toContain("SMIC a 1600 euros");
    site.items.delete("wp:media:26000");
    deps.setRetrievalDeps({ embedder, vector: deps.pgVector() });
  });

  it("ajout manuel d'un texte par l'équipe", async () => {
    const run = await mastra.getWorkflow("ingest").createRun();
    const res = await run.start({
      inputData: {
        mode: "manuel",
        title: "Note de campagne sur les transports",
        text: filler("les transports gratuits").join("\n"),
        addedBy: "equipe:1",
      },
    });
    expect(res.status).toBe("success");
    if (res.status !== "success") return;
    expect(res.result.documents[0]).toMatchObject({ status: "indexé", category: "ajout_manuel" });
    const manual = (await store.listDocuments("manuel"))[0];
    expect(manual).toMatchObject({ title: "Note de campagne sur les transports", included: true });
  });
});
