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
import { makeEpub } from "./helpers/epub.js";
import { ANCIEN_PROGRAMME } from "../src/corpus/classify.js";

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

    // Ancienne version du programme : seul le livre 2026 fait foi.
    expect(byId["wp:media:15699"]).toMatchObject({ status: "écarté", category: "programme", detail: ANCIEN_PROGRAMME });
    expect(byId["wp:media:12361"]).toMatchObject({ status: "indexé", category: "livret" });
    expect(byId["wp:media:13782"]).toMatchObject({ status: "indexé", category: "plan" });
    expect(byId["wp:media:13769"]).toMatchObject({ status: "écarté", detail: "Doublon exact de wp:media:13782" });
    expect(byId["wp:media:25528"]).toMatchObject({ status: "écarté", category: "autre" });
    expect(byId["wp:media:19642"]).toMatchObject({ status: "écarté", category: "archive" });
    expect(byId["wp:media:22111"]).toMatchObject({ status: "écarté", detail: "Extraction non exploitable" });
    expect(r).toMatchObject({ indexed: 2, excluded: 5, errors: 0, unchanged: 0 });

    // Rien d'indexé pour les documents écartés.
    const excluded = await pool.query(
      `SELECT count(*)::int n FROM ${PASSAGES_INDEX} WHERE metadata->>'docId' IN ('wp:media:15699','wp:media:13769','wp:media:25528','wp:media:19642')`,
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

  it("ancien programme indexé avant le changement de règle : retiré au scan suivant, sans --force", async () => {
    const { classifyByMetadata } = await import("../src/corpus/classify.js");
    const item = site.items.get("wp:media:15699")!;
    // État d'avant : le PDF 2025 était inclus, avec ses passages.
    const metadata = {
      docId: item.id, title: item.title, url: item.url, page: 2, section: null, category: "programme",
      corpus: "aec2027", origin: "wordpress", modified: item.modified, provisional: true, text: "retraite a 60 ans (ancien)",
    };
    await store.saveDocument({
      item, cls: { ...classifyByMetadata(item), included: true, reason: "" }, pages: 2, characters: 100, contentHash: "ancien",
      passages: [{ id: `${item.id}#p2#0`, text: metadata.text, metadata: metadata as never }],
      vectors: await embedder.embed([metadata.text]),
    });
    const r = await scan();
    expect(r.documents).toEqual([expect.objectContaining({ id: "wp:media:15699", status: "écarté" })]);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM ${PASSAGES_INDEX} WHERE metadata->>'docId' = 'wp:media:15699'`);
    expect(rows[0].n).toBe(0);
  });

  it("livre du programme (EPUB) : indexé par section, remplacé par une nouvelle version, ignoré par le scan", async () => {
    const { ajouterLivre, LIVRE_ID } = await import("../src/corpus/manual.js");
    const v1 = await ajouterLivre(mastra, makeEpub({ modified: "2026-11-01T00:00:00Z", retraite: "version un" }), "cli:test");
    expect(v1).toMatchObject({ id: LIVRE_ID, status: "indexé", category: "programme", title: "L'Avenir en commun (livre, édition 2026)" });
    const r = await ajouterLivre(mastra, makeEpub(), "cli:test");
    expect(r).toMatchObject({ id: LIVRE_ID, status: "indexé" });
    const { rows } = await pool.query(
      `SELECT metadata FROM ${PASSAGES_INDEX} WHERE metadata->>'docId' = $1 ORDER BY (metadata->>'page')::int`,
      [LIVRE_ID],
    );
    expect(rows.some((x) => x.metadata.text.includes("version un"))).toBe(false); // l'ancienne version est remplacée
    expect(rows.find((x) => x.metadata.text.includes("retraite a 60 ans"))?.metadata).toMatchObject({
      page: 4, section: expect.stringMatching(/› Garantir une retraite digne$/), url: "", category: "programme",
      corpus: "aec2027", provisional: false, origin: "manuel",
    });
    // Le scan WordPress ne le voit pas « disparu ».
    const s = await scan();
    expect(s.removed).toEqual([]);
    expect((await store.listDocuments()).some((d) => d.id === LIVRE_ID)).toBe(true);
  });

  it("recherche : retrouve le passage avec sa section, filtrée par édition", async () => {
    const deps = await import("../src/corpus/deps.js");
    deps.setRetrievalDeps({ embedder, vector: deps.pgVector() });
    const { searchPassages } = await import("../src/aec/search.js");
    const { rows } = await pool.query(
      `SELECT metadata->>'text' AS text FROM ${PASSAGES_INDEX} WHERE metadata->>'text' LIKE '%retraite a 60 ans%' LIMIT 1`,
    );
    // L'embedder simulé n'est pas sémantique : on cherche le texte exact du passage.
    const hits = await searchPassages({ requete: rows[0].text, topK: 3 });
    expect(hits[0]).toMatchObject({
      docId: "manual:livre-aec", page: 4, section: expect.stringMatching(/Garantir une retraite digne$/),
      category: "programme", provisional: false, corpus: "aec2027", url: "",
    });
    expect(hits[0]!.score).toBeGreaterThan(0.99);
    // Le livret Santé « UP » est de la campagne 2022 : seul lui sort quand on filtre sur 2022.
    const old = await searchPassages({ requete: rows[0].text, edition: "aec2022" });
    expect(old.length).toBeGreaterThan(0);
    expect(old.every((h) => h.corpus === "aec2022" && h.docId !== "manual:livre-aec")).toBe(true);
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

  it("ajout manuel d'un PDF (sans WordPress), liste, puis suppression", async () => {
    const { ajouterDocument, listerDocuments, shortId, supprimerDocument } = await import("../src/corpus/manual.js");
    const pdf = makePdf([filler("la note interne"), ["Page deux : le SMIC a 1600 euros net.", ...filler("les salaires")]]);
    const r = await ajouterDocument(mastra, { title: "Note interne salaires", pdf, addedBy: "Camille (u_abc)" });
    expect(r).toMatchObject({ status: "indexé", category: "ajout_manuel" });
    const { rows } = await pool.query(
      `SELECT metadata FROM ${PASSAGES_INDEX} WHERE metadata->>'docId' = $1 AND metadata->>'text' LIKE '%1600 euros%'`,
      [r.id],
    );
    expect(rows[0]?.metadata).toMatchObject({ page: 2, url: "", category: "ajout_manuel", corpus: "aec2027" });

    const docs = await listerDocuments();
    expect(docs[0]).toMatchObject({ id: r.id, title: "Note interne salaires", included: true, addedBy: "Camille (u_abc)" });

    // Un document du WordPress ne peut pas être supprimé ainsi (le scan le remettrait).
    await expect(supprimerDocument("15699", "Camille")).rejects.toThrow(/Aucun document ajouté à la main/);
    await expect(supprimerDocument(shortId(r.id), "Camille (u_abc)")).resolves.toMatchObject({ title: "Note interne salaires" });
    const left = await pool.query(`SELECT count(*)::int n FROM ${PASSAGES_INDEX} WHERE metadata->>'docId' = $1`, [r.id]);
    expect(left.rows[0].n).toBe(0);
    const log = await pool.query(`SELECT who, action, title FROM aec_admin_log WHERE doc_id = $1 ORDER BY id`, [r.id]);
    expect(log.rows).toEqual([
      { who: "Camille (u_abc)", action: "ajouter", title: "Note interne salaires" },
      { who: "Camille (u_abc)", action: "supprimer", title: "Note interne salaires" },
    ]);
  });

  it("ajout manuel : un PDF scanné (sans texte) est refusé avec la raison", async () => {
    const { ajouterDocument } = await import("../src/corpus/manual.js");
    const r = await ajouterDocument(mastra, { title: "Scan illisible", pdf: makePdf([["."], ["."]]), addedBy: "Camille" });
    expect(r).toMatchObject({ status: "écarté", detail: "Extraction non exploitable" });
    await expect(ajouterDocument(mastra, { title: "x", text: "y", addedBy: "Camille" })).rejects.toThrow(/titre/);
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
    const manual = (await store.listDocuments("manuel")).find((d) => d.title.startsWith("Note de campagne"));
    expect(manual).toMatchObject({ title: "Note de campagne sur les transports", included: true });
  });
});
