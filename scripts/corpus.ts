/**
 * État de la base documentaire, et test de la recherche.
 *   pnpm corpus                       documents par catégorie, passages indexés
 *   pnpm corpus --liste               + la liste des documents (inclus et écartés)
 *   pnpm corpus --chercher "SMIC"     les passages que l'agent recevrait pour cette requête
 */
import { parseArgs } from "node:util";
import { PASSAGES_INDEX } from "../src/config.js";
import { searchPassages } from "../src/aec/search.js";
import { pgVector } from "../src/corpus/deps.js";

const { values } = parseArgs({
  options: { liste: { type: "boolean", default: false }, chercher: { type: "string" } },
});
const pool = pgVector().pool;

try {
  const exists = await pool.query(`SELECT to_regclass('aec_documents') AS d, to_regclass('${PASSAGES_INDEX}') AS p`);
  if (!exists.rows[0].d || !exists.rows[0].p) {
    console.log("Base vide : aucun scan n'a encore abouti. Lancer `pnpm ingest`.");
    process.exit(0);
  }

  const { rows: cats } = await pool.query(`
    SELECT category, included, count(*)::int AS documents, sum(passages)::int AS passages
      FROM aec_documents GROUP BY category, included ORDER BY included DESC, category`);
  const total = await pool.query(`SELECT count(*)::int AS n FROM ${PASSAGES_INDEX}`);

  console.log("Documents par catégorie");
  for (const c of cats) {
    console.log(`  ${c.included ? "inclus " : "écarté "} ${c.category.padEnd(17)} ${String(c.documents).padStart(3)} documents  ${String(c.passages).padStart(5)} passages`);
  }
  console.log(`\n${total.rows[0].n} passages dans l'index pgvector`);

  if (values.liste) {
    const { rows } = await pool.query(
      `SELECT id, title, category, included, reason, pages, passages, modified FROM aec_documents ORDER BY included DESC, category, title`,
    );
    console.log("\nDocuments");
    for (const d of rows) {
      const why = d.included ? "" : `  (${d.reason})`;
      console.log(`  ${d.included ? "✓" : "✗"} ${d.category.padEnd(17)} ${String(d.pages).padStart(3)} p. ${String(d.passages).padStart(4)} passages  ${d.title}${why}`);
    }
  }

  if (values.chercher) {
    const hits = await searchPassages({ requete: values.chercher, topK: 8 });
    console.log(`\nRecherche « ${values.chercher} » : ${hits.length} passages`);
    for (const h of hits) {
      const extrait = h.text.replace(/\s+/g, " ").slice(0, 140);
      console.log(`  ${h.score.toFixed(3)}  ${h.title} — ${h.page ? `p. ${h.page}` : "web"} (${h.category})\n         ${extrait}…`);
    }
  }
} finally {
  await pool.end();
}
