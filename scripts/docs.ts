/**
 * Gérer les documents ajoutés à la main, depuis le terminal (sans passer par WordPress ni Telegram).
 *   pnpm docs:prod liste
 *   pnpm docs:prod ajouter --titre "Note sur les retraites" --fichier note.pdf
 *   pnpm docs:prod ajouter --titre "Tribune" --url https://exemple.fr/tribune
 *   pnpm docs:prod ajouter --titre "Mémo" --texte-fichier memo.txt
 *   pnpm docs:prod supprimer 3f2a9c1b
 *   pnpm docs:prod livre L_Avenir_en_commun.epub     (le livre du programme : remplace la version précédente)
 * (`pnpm docs …` fait la même chose sur la base locale de .env)
 */
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { mastra } from "../src/mastra/index.js";
import { ajouterDocument, ajouterLivre, listerDocuments, shortId, supprimerDocument } from "../src/corpus/manual.js";

const { values, positionals } = parseArgs({
  options: {
    titre: { type: "string" },
    fichier: { type: "string" },
    url: { type: "string" },
    texte: { type: "string" },
    "texte-fichier": { type: "string" },
  },
  allowPositionals: true,
});
const [cmd, arg] = positionals;
const who = `cli:${userInfo().username}`;

try {
  if (cmd === "liste") {
    const docs = await listerDocuments();
    if (docs.length === 0) console.log("Aucun document ajouté à la main.");
    for (const d of docs) {
      const etat = d.included ? `${d.passages} passages` : `écarté : ${d.reason}`;
      console.log(`${shortId(d.id)}  ${d.title}  (${etat}, ${new Date(d.indexedAt).toLocaleString("fr-FR")}, ${d.addedBy ?? "?"})`);
    }
  } else if (cmd === "ajouter") {
    if (!values.titre) throw new Error("--titre est obligatoire");
    const pdf = values.fichier ? new Uint8Array(await readFile(values.fichier)) : undefined;
    const text = values["texte-fichier"] ? await readFile(values["texte-fichier"], "utf8") : values.texte;
    if (!pdf && !text && !values.url) throw new Error("Il faut --fichier, --url, --texte ou --texte-fichier");
    const r = await ajouterDocument(mastra, { title: values.titre, pdf, url: values.url, text, addedBy: who });
    console.log(
      r.status === "indexé"
        ? `Ajouté : ${r.passages} passages, identifiant ${shortId(r.id)}`
        : `${r.status === "écarté" ? "Non ajouté" : "Échec"} : ${r.detail}`,
    );
    if (r.status !== "indexé") process.exitCode = 2;
  } else if (cmd === "livre") {
    if (!arg) throw new Error("Donne le chemin de l'EPUB du livre");
    const r = await ajouterLivre(mastra, new Uint8Array(await readFile(arg)), who);
    console.log(r.status === "indexé" ? `Livre indexé : ${r.passages} passages (${r.title})` : `${r.status} : ${r.detail}`);
    if (r.status !== "indexé") process.exitCode = 2;
  } else if (cmd === "supprimer") {
    if (!arg) throw new Error("Donne l'identifiant affiché par « liste »");
    const d = await supprimerDocument(arg, who);
    console.log(`Retiré du corpus : ${d.title}`);
  } else {
    console.log("Usage : pnpm docs:prod liste | ajouter --titre … (--fichier f.pdf|f.epub | --url … | --texte … | --texte-fichier f.txt) | livre f.epub | supprimer <id>");
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
process.exit();
