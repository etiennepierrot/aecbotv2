import type { Answer, Source } from "../aec/types.js";
import type { Category, Corpus } from "../corpus/types.js";

export const DISCLAIMER = "Initiative non officielle, non endossée par LFI.";
const MAX_LENGTH = 4000; // Telegram coupe à 4096 caractères

/** Réponse vérifiée → message Telegram (parse_mode HTML). */
export function formatAnswer(answer: Answer): string {
  const parts = [markdownToTelegramHtml(answer.texte)];
  if (answer.sources.length) parts.push(answer.sources.map(formatSource).join("\n"));
  const notes = [...answer.avertissements, DISCLAIMER].map((n) => `<i>${escapeHtml(n)}</i>`).join("\n");
  parts.push(notes);
  const msg = parts.join("\n\n");
  return msg.length <= MAX_LENGTH ? msg : truncate(answer, notes);
}

function formatSource(s: Source): string {
  const first = s.pages[0];
  if (!s.url) {
    // Document ajouté par l'équipe sans lien public (PDF envoyé au bot, texte).
    const where = s.pages.length ? `, page${s.pages.length > 1 ? "s" : ""} ${s.pages.join(", ")}` : "";
    return `[${s.n}] ${escapeHtml(prettyTitle(s.title, s.category, s.corpus))}${where} (document de l'équipe)`;
  }
  const href = first ? `${s.url}#page=${first}` : s.url;
  const where = s.pages.length === 0 ? "" : s.pages.length === 1 ? `, page ${first}` : `, pages ${s.pages.join(", ")}`;
  const old = s.corpus === "aec2022" ? " (version 2022, pas à jour)" : "";
  return `[${s.n}] <a href="${escapeAttr(href)}">${escapeHtml(prettyTitle(s.title, s.category, s.corpus))}</a>${where}${old}`;
}

function truncate(answer: Answer, notes: string): string {
  const sources = answer.sources.map(formatSource).join("\n");
  const room = MAX_LENGTH - sources.length - notes.length - 10;
  return [markdownToTelegramHtml(answer.texte.slice(0, Math.max(room, 200))) + "…", sources, notes].join("\n\n");
}

/** Résumé gardé en mémoire pour les questions de suite : la réponse et ses sources. */
export function answerForMemory(answer: Answer): string {
  if (answer.statut === "introuvable") return "Rien trouvé dans le corpus.";
  const sources = answer.sources.map(
    (s) => `[${s.n}] ${prettyTitle(s.title, s.category, s.corpus)}${s.pages.length ? ` p. ${s.pages.join(", ")}` : ""}`,
  );
  return `${answer.texte}\nSources : ${sources.join(" ; ")}`;
}

const ACCENTS: Record<string, string> = {
  sante: "santé", education: "éducation", ecologie: "écologie", energies: "énergies", securite: "sécurité",
  ruralite: "ruralité", laicite: "laïcité", defense: "défense", rep: "République", republique: "République",
  numerique: "numérique", dechets: "déchets", medias: "médias", foret: "forêt", egalite: "égalité",
  qualif: "qualifications", alim: "alimentation", "pouvoir achat": "pouvoir d'achat", etr: "étrangers",
  "fra etr": "Français de l'étranger", feminicides: "féminicides", pauvrete: "pauvreté",
  "regle verte": "règle verte", sdf: "sans-abrisme", "plein emploi": "plein-emploi",
  "outre mer": "Outre-mer", "condition animale": "condition animale", "quartiers populaires": "quartiers populaires",
  auto: "automobile", "droit travail": "droit du travail", "produire france": "produire en France", europe: "Europe",
  efh: "égalité femmes-hommes", esr: "enseignement supérieur et recherche", ess: "économie sociale et solidaire",
};
const ACRONYMS = new Set(["btp", "ess", "lgbti", "esr", "efh", "nfp", "aec", "falc"]);

/** « Livret_UP_13_SANTE_web-ok » → « Livret « santé » ». Les noms de fichiers WordPress ne sont pas faits pour être lus. */
export function prettyTitle(title: string, category: Category, corpus: Corpus = "aec2027"): string {
  if (category === "programme") {
    return corpus === "aec2022" ? "Programme L'Avenir en commun 2022 (version abrégée)" : "Programme L'Avenir en commun";
  }
  if (category === "page" || category === "ajout_manuel") return title;

  let t = title
    .replace(/\.pdf$/i, "")
    .replace(/\(\d+\)/g, " ")
    .replace(/^[_\s-]+/, "")
    .replace(/^(?:livret|plan)[_ -]+(?:UP[_ -]+)?(?:\d+[_ -]+)?/i, "")
    .replace(/[_ -](?:web|vweb|ok|vf\d*|impression|sans[_ ]tdc|aec|avenir[_ -]en[_ -]commun|vf[_ ]st|st|\d{6})(?=$|[_ -])/gi, " ")
    .replace(/[_ -]+\d*$/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  // Un autre nettoyage peut laisser des suffixes : on recommence une fois.
  t = t
    .replace(/\s(?:web|ok|vweb|\d)$/g, "")
    .replace(/^(?:m \d+ )?(?:ass )?(?:plan|livret) /, "") // « M 27 PLAN BTP… », « ASS-LIVRET-ESR… »
    .replace(/\b([ldjnst]) (?=[aeiouhéè])/g, "$1'") // « l ordre » → « l'ordre »
    .trim();

  const phrase = ACCENTS[t];
  if (phrase) t = phrase;
  else t = t.split(" ").map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : (ACCENTS[w] ?? w))).join(" ");

  const isLivret = /livret/i.test(title);
  const isPlan = /(^|[_ -])plan([_ -]|$)/i.test(title);
  if (category === "livret" || (category === "publication_2026" && isLivret)) return `Livret « ${t} »`;
  if (category === "plan" || (category === "publication_2026" && isPlan)) return `Plan « ${t.replace(/^plan /, "")} »`;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Le peu de Markdown que les modèles écrivent malgré tout → HTML de Telegram.
 * Le texte est échappé d'abord : rien d'autre que ces balises ne peut passer.
 */
export function markdownToTelegramHtml(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      let l = escapeHtml(line);
      const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(l);
      if (heading) return `<b>${heading[1]!.replace(/\*\*/g, "")}</b>`;
      l = l.replace(/^(\s*)[-*+]\s+/, "$1• ");
      l = l.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<b>$1</b>");
      l = l.replace(/__(?=\S)(.+?)(?<=\S)__/g, "<b>$1</b>");
      l = l.replace(/(^|[\s(])\*(?=\S)([^*]+?)(?<=\S)\*(?=[\s.,;:!?)]|$)/g, "$1<i>$2</i>");
      l = l.replace(/(^|[\s(])_(?=\S)([^_]+?)(?<=\S)_(?=[\s.,;:!?)]|$)/g, "$1<i>$2</i>");
      return l.replace(/\*\*/g, ""); // gras non refermé : on retire les astérisques
    })
    .join("\n");
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
