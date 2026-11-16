import type { PassageCollector } from "./collector.js";
import { INTROUVABLE_TEXTE, type Answer, type ReferencedPassage, type Source } from "./types.js";

const MARKER = /\[\s*(P\d+(?:\s*[,;]\s*P\d+)*)\s*\]/gi;

/**
 * Transforme le texte du modèle en réponse vérifiée :
 * - une référence [Pn] que l'outil n'a pas renvoyée est rejetée ;
 * - une phrase dont toutes les références sont rejetées est retirée ;
 * - les références restantes deviennent [1], [2]… (une par document, avec ses pages ou sections) ;
 * - s'il ne reste aucune citation valide, la réponse devient « introuvable ».
 */
export function verifyAnswer(raw: string, collector: PassageCollector): Answer {
  const controle: Answer["controle"] = {
    passagesRecuperes: collector.size,
    citationsValides: 0,
    citationsRejetees: 0,
    phrasesRetirees: 0,
    phrasesSansSource: 0,
  };
  const { texte: text, suites: brutes } = parseSuites(raw);
  if (!text || /^\W*INTROUVABLE\b/i.test(text)) return introuvable(controle);

  const sources: Source[] = [];
  const sourceKey = new Map<string, number>();
  // Un numéro par document (pas par page) : une réponse qui cite 3 pages du même livret
  // affiche [4] et « pages 3, 21, 23 » plutôt que trois sources.
  // Clé : le document (deux documents sans lien public ont la même URL vide).
  const sectionRank = new Map<string, number>();
  const numberFor = (p: ReferencedPassage): number => {
    let n = sourceKey.get(p.docId);
    if (n === undefined) {
      n = sources.length + 1;
      sourceKey.set(p.docId, n);
      sources.push({
        n, docId: p.docId, title: p.title, url: p.url, pages: [], sections: [],
        category: p.category, corpus: p.corpus, provisional: p.provisional,
      });
    }
    const source = sources[n - 1]!;
    if (p.page !== null && !source.pages.includes(p.page)) {
      source.pages.push(p.page);
      source.pages.sort((a, b) => a - b);
    }
    // EPUB : une section longue coupée en deux « pages » ne s'affiche qu'une fois, dans l'ordre du livre.
    if (p.section && !source.sections.includes(p.section)) {
      sectionRank.set(p.section, p.page ?? 0);
      source.sections.push(p.section);
      source.sections.sort((a, b) => sectionRank.get(a)! - sectionRank.get(b)!);
    }
    return n;
  };

  const lines = text.split("\n").map((line) => {
    const kept: string[] = [];
    for (const sentence of splitSentences(line)) {
      const refs = [...sentence.matchAll(MARKER)].flatMap((m) => m[1]!.split(/[,;]/).map((r) => r.trim()));
      if (refs.length === 0) {
        if (/\p{L}/u.test(sentence)) controle.phrasesSansSource++;
        kept.push(sentence);
        continue;
      }
      const valid = refs.map((r) => collector.get(r)).filter((p): p is ReferencedPassage => !!p);
      controle.citationsRejetees += refs.length - valid.length;
      if (valid.length === 0) {
        controle.phrasesRetirees++;
        continue;
      }
      controle.citationsValides += valid.length;
      kept.push(
        sentence.replace(MARKER, (_m, group: string) => {
          const ns = group
            .split(/[,;]/)
            .map((r) => collector.get(r.trim()))
            .filter((p): p is ReferencedPassage => !!p)
            .map(numberFor);
          return [...new Set(ns)].map((n) => `[${n}]`).join("");
        })
        // [P1][P2] sur deux pages du même document donnent [1][1] : on fusionne.
        .replace(/(?:\[\d+\]\s*){2,}/g, (run) => {
          const ns = [...new Set(run.match(/\d+/g)!)];
          return ns.map((n) => `[${n}]`).join("") + (/\s$/.test(run) ? " " : "");
        }),
      );
    }
    return kept.join(" ");
  });

  if (controle.citationsValides === 0) return introuvable(controle);

  const texte = lines
    .join("\n")
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "") // séparateur Markdown, affiché tel quel dans Telegram
    .replace(/[ \t]+([.,])/g, "$1") // espace laissé par une référence retirée ; « : ; ! ? » gardent la leur
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const avertissements: string[] = [];
  if (sources.some((s) => s.provisional)) {
    avertissements.push("Programme provisoire : une édition plus récente peut exister.");
  }
  if (sources.some((s) => s.corpus === "aec2022")) {
    avertissements.push(
      "Cette réponse s'appuie en partie sur des documents de la campagne 2022, qui ne sont pas à jour : " +
        "le programme qui fait foi est le livre L'Avenir en commun (édition 2026).",
    );
  }
  const { gardees: suites, sansPassage } = suitesVerifiees(brutes, collector);
  if (brutes.length) controle.suitesSansPassage = sansPassage;
  return { statut: "repondu", texte, sources, avertissements, suites, controle };
}

const SUITES_HEADING = /^\s*(?:\*\*)?\s*(?:SUITES|Pour aller plus loin)\s*(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$/im;
export const MAX_SUITES = 3;
const MAX_SUITE_LENGTH = 120;

export interface SuiteBrute {
  question: string;
  /** Références [Pn] écrites par le modèle : le passage qui répond à la suite. */
  refs: string[];
}

/**
 * Sépare le bloc « SUITES : » (questions d'approfondissement) du corps de la réponse.
 * Ne garde que de vraies questions, courtes, sans doublon ; les références sont mises à part.
 */
export function parseSuites(raw: string): { texte: string; suites: SuiteBrute[] } {
  const text = raw.trim();
  const m = SUITES_HEADING.exec(text);
  if (!m) return { texte: text, suites: [] };
  const suites: SuiteBrute[] = [];
  for (const line of text.slice(m.index + m[0].length).split("\n")) {
    const item = /^\s*(?:\d+\s*[.)]|[-*•])\s*(.+)$/.exec(line)?.[1];
    if (!item) continue;
    const refs = [...item.matchAll(MARKER)].flatMap((r) => r[1]!.split(/[,;]/).map((x) => x.trim()));
    const question = item
      .replace(MARKER, "")
      .replace(/\*\*|__|[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (question.length < 8 || question.length > MAX_SUITE_LENGTH || !question.endsWith("?")) continue;
    if (!suites.some((s) => s.question.toLowerCase() === question.toLowerCase())) suites.push({ question, refs });
  }
  return { texte: text.slice(0, m.index).trim(), suites };
}

/** Les passages que le texte du modèle cite réellement (références [Pn] valides), sans doublon. */
export function passagesCites(raw: string, collector: PassageCollector): ReferencedPassage[] {
  const { texte } = parseSuites(raw);
  const refs = [...texte.matchAll(MARKER)].flatMap((m) => m[1]!.split(/[,;]/).map((r) => r.trim()));
  const vus = new Map<string, ReferencedPassage>();
  for (const r of refs) {
    const p = collector.get(r);
    if (p) vus.set(p.ref, p);
  }
  return [...vus.values()];
}

/** Les questions de suite seules (3 au plus), sans vérifier leurs références. */
export function extractSuites(raw: string): { texte: string; suites: string[] } {
  const { texte, suites } = parseSuites(raw);
  return { texte, suites: suites.slice(0, MAX_SUITES).map((s) => s.question) };
}

/**
 * Comme pour les affirmations : une suite n'est gardée que si elle cite un passage que
 * la recherche a vraiment renvoyé. Sans passage, rien ne dit que le corpus sait y répondre.
 */
export function suitesVerifiees(suites: SuiteBrute[], collector: PassageCollector): { gardees: string[]; sansPassage: number } {
  const avecPassage = suites.filter((s) => s.refs.some((r) => collector.get(r)));
  return { gardees: avecPassage.slice(0, MAX_SUITES).map((s) => s.question), sansPassage: suites.length - avecPassage.length };
}

function introuvable(controle: Answer["controle"]): Answer {
  return { statut: "introuvable", texte: INTROUVABLE_TEXTE, sources: [], avertissements: [], controle };
}

/**
 * Découpe une ligne en phrases. Une référence placée après le point
 * (« … cotisation. [P1] ») reste attachée à sa phrase.
 */
export function splitSentences(line: string): string[] {
  const parts = line.split(/(?<=[.!?…])\s+/);
  const out: string[] = [];
  for (const part of parts) {
    let rest = part.trim();
    // Références en tête de segment : elles appartiennent à la phrase précédente.
    const lead = /^((?:\[[^\]]*\]\s*)+[.!?…]?)\s*/.exec(rest);
    if (lead && out.length > 0) {
      out[out.length - 1] += ` ${lead[1]!.trim()}`;
      rest = rest.slice(lead[0].length);
    }
    if (rest) out.push(rest);
  }
  return out;
}
