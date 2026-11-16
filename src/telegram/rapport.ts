import { escapeHtml } from "./format.js";
import type { BotStore, EchangeRapport } from "./store.js";

/**
 * Rapport journalier pour l'équipe : volumes, taux d'introuvables, contrôles, votes, coût, et
 * les questions à revoir (introuvables, 👎, commentaires). Envoyé chaque matin par le workflow
 * `rapport` (RAPPORT_CRON) aux membres de TEAM_TELEGRAM_IDS, et lisible par `pnpm rapport:prod`.
 * Pseudonymes tronqués, jamais de nom ni d'identifiant Telegram.
 */

export interface Vote {
  traceId?: string;
  feedbackType: string;
  value: unknown;
  timestamp: string | Date;
}

export interface DonneesRapport {
  depuis: Date;
  jusqua: Date;
  echanges: EchangeRapport[];
  incidents: { erreur: number; limite: number };
  avis: number;
  /** Votes et commentaires reçus pendant la période (sur des réponses de la période ou d'avant). */
  votes: Vote[];
  /** Question et réponse des traces votées, quand elles sont encore en mémoire. */
  echangesVotes: Map<string, { question: string; answer: string }>;
}

export interface SourcesRapport {
  store: Pick<BotStore, "echangesEntre" | "incidentsEntre" | "avisEntre" | "exchanges">;
  /** Votes et commentaires depuis une date (stockage d'observabilité de Mastra). */
  votesDepuis: (depuis: Date) => Promise<Vote[]>;
}

export async function collecterRapport(src: SourcesRapport, depuis: Date, jusqua: Date): Promise<DonneesRapport> {
  const [echanges, incidents, avis, tous] = await Promise.all([
    src.store.echangesEntre(depuis, jusqua),
    src.store.incidentsEntre(depuis, jusqua),
    src.store.avisEntre(depuis, jusqua),
    src.votesDepuis(depuis),
  ]);
  const votes = tous.filter((v) => new Date(v.timestamp) < jusqua);
  const traces = [...new Set(votes.map((v) => v.traceId).filter((t): t is string => !!t))];
  return { depuis, jusqua, echanges, incidents, avis, votes, echangesVotes: await src.store.exchanges(traces) };
}

/** Lit tous les votes depuis une date dans le stockage d'observabilité (paginé). */
export function votesDepuisObservabilite(obs: {
  listFeedback: (args: object) => Promise<{ feedback: Vote[] }>;
}): SourcesRapport["votesDepuis"] {
  return async (depuis) => {
    const votes: Vote[] = [];
    for (let page = 0; ; page++) {
      const res = await obs.listFeedback({
        filters: { timestamp: { start: depuis } },
        pagination: { page, perPage: 100 },
        orderBy: { field: "timestamp", direction: "ASC" },
      });
      votes.push(...res.feedback);
      if (res.feedback.length < 100) break;
    }
    return votes;
  };
}

/** Réponse gardée en mémoire pour une question restée sans réponse (answerForMemory). */
const INTROUVABLE_MEMOIRE = "Rien trouvé dans le corpus.";

const statutDe = (e: EchangeRapport) => e.meta?.statut ?? (e.answer === INTROUVABLE_MEMOIRE ? "introuvable" : "repondu");

export interface OptionsFormat {
  /** Questions listées au plus par rubrique (le reste : « … et N autres »). */
  maxParListe?: number;
}

/** Le rapport en HTML Telegram (b, i, code). */
export function formatRapport(d: DonneesRapport, { maxParListe = 10 }: OptionsFormat = {}): string {
  const e = d.echanges;
  const pct = (n: number, sur: number) => (sur ? `${Math.round((n * 100) / sur)} %` : "—");
  const introuvables = e.filter((x) => statutDe(x) === "introuvable");
  const partielles = e.filter((x) => x.meta?.objet);
  const ecartees = partielles.filter((x) => x.meta?.objet === "non");
  const avecRejets = e.filter((x) => (x.meta?.citationsRejetees ?? 0) > 0);
  const personnes = new Set(e.map((x) => x.pseudo)).size;
  const suites = e.filter((x) => x.meta?.origine === "suite").length;

  const pouces = d.votes.filter((v) => v.feedbackType === "thumbs");
  const haut = pouces.filter((v) => v.value === 1).length;
  const bas = pouces.filter((v) => v.value === -1).length;
  const commentaires = d.votes.filter((v) => v.feedbackType === "comment");

  const avecMeta = e.filter((x) => x.meta);
  const jetonsEntree = avecMeta.reduce((n, x) => n + x.meta!.inputTokens, 0);
  const jetonsSortie = avecMeta.reduce((n, x) => n + x.meta!.outputTokens, 0);
  const durees = avecMeta.map((x) => x.meta!.ms).sort((a, b) => a - b);
  const mediane = durees.length ? durees[Math.floor(durees.length / 2)]! : 0;
  const sec = (ms: number) => `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
  const nb = (n: number) => n.toLocaleString("fr-FR");

  const date = (x: Date) =>
    x.toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const lignes: string[] = [
    `📊 <b>Rapport du bot</b>, du ${date(d.depuis)} au ${date(d.jusqua)}`,
    "",
    `<b>${nb(e.length)}</b> question${e.length > 1 ? "s" : ""} de <b>${nb(personnes)}</b> personne${personnes > 1 ? "s" : ""}` +
      (suites ? ` (dont ${nb(suites)} suite${suites > 1 ? "s" : ""} choisie${suites > 1 ? "s" : ""})` : ""),
    `✅ répondues : ${nb(e.length - introuvables.length)} · ❔ introuvables : ${nb(introuvables.length)} (${pct(introuvables.length, e.length)})`,
  ];
  if (partielles.length) {
    lignes.push(
      `🔎 réponses partielles contrôlées : ${nb(partielles.length)}, dont ${nb(ecartees.length)} écartée${ecartees.length > 1 ? "s" : ""} (thème voisin)` +
        (partielles.some((x) => x.meta?.objet === "erreur") ? `, ${nb(partielles.filter((x) => x.meta?.objet === "erreur").length)} contrôle(s) en panne` : ""),
    );
  }
  const rejets = avecRejets.reduce((n, x) => n + x.meta!.citationsRejetees, 0);
  lignes.push(
    `🧾 citations inventées rejetées : ${nb(rejets)}${avecRejets.length ? ` (dans ${nb(avecRejets.length)} réponse${avecRejets.length > 1 ? "s" : ""})` : ""}`,
    `👍 ${nb(haut)} · 👎 ${nb(bas)} · 💬 ${nb(commentaires.length)} commentaire${commentaires.length > 1 ? "s" : ""} · avis /avis : ${nb(d.avis)}`,
    `⚠️ pannes : ${nb(d.incidents.erreur)} · refus pour limite horaire : ${nb(d.incidents.limite)}`,
  );
  if (avecMeta.length) {
    lignes.push(
      `⏱ temps de réponse : médiane ${sec(mediane)}, max ${sec(durees.at(-1)!)} · ` +
        `jetons : ${nb(jetonsEntree)} en entrée, ${nb(jetonsSortie)} en sortie (${nb(Math.round(jetonsEntree / avecMeta.length))}+${nb(Math.round(jetonsSortie / avecMeta.length))} par question)`,
    );
  }

  const court = (s: string, n: number) => escapeHtml(s.length <= n ? s : `${s.slice(0, n)}…`);
  const qui = (pseudo: string) => `<code>${escapeHtml(pseudo.slice(0, 10))}</code>`;
  const reste = (n: number) => (n > maxParListe ? [`<i>… et ${n - maxParListe} autre(s) : pnpm rapport:prod</i>`] : []);

  if (introuvables.length) {
    lignes.push("", `<b>❔ Questions restées sans réponse</b> : des trous du corpus, ou des questions hors programme`);
    for (const x of introuvables.slice(0, maxParListe)) {
      const ecart = x.meta?.objet === "non" ? " <i>(écartée par le contrôle)</i>" : "";
      lignes.push(`• « ${court(x.question, 200)} » ${qui(x.pseudo)}${ecart}`);
    }
    lignes.push(...reste(introuvables.length));
  }

  // Votes 👎 et commentaires, regroupés par réponse.
  const negatifs = new Map<string, Vote[]>();
  for (const v of d.votes) {
    if (!v.traceId) continue;
    if ((v.feedbackType === "thumbs" && v.value === -1) || v.feedbackType === "comment") {
      negatifs.set(v.traceId, [...(negatifs.get(v.traceId) ?? []), v]);
    }
  }
  if (negatifs.size) {
    lignes.push("", `<b>👎 Réponses critiquées</b>`);
    for (const [trace, vs] of [...negatifs].slice(0, maxParListe)) {
      const ex = d.echangesVotes.get(trace);
      const pouce = vs.some((v) => v.feedbackType === "thumbs") ? "👎 " : "";
      lignes.push(
        ex
          ? `• ${pouce}« ${court(ex.question, 200)} »\n   → ${court(ex.answer.replace(/\s+/g, " "), 300)}`
          : `• ${pouce}<i>(question et réponse plus en mémoire)</i>`,
      );
      for (const c of vs.filter((v) => v.feedbackType === "comment")) lignes.push(`   💬 « ${court(String(c.value), 300)} »`);
    }
    lignes.push(...reste(negatifs.size));
  }

  if (avecRejets.length) {
    lignes.push("", `<b>🧾 Réponses où le modèle a cité un passage qu'il n'avait pas reçu</b> (corrigées avant envoi)`);
    for (const x of avecRejets.slice(0, maxParListe)) lignes.push(`• « ${court(x.question, 200)} » (${x.meta!.citationsRejetees})`);
    lignes.push(...reste(avecRejets.length));
  }

  const calme = e.length === 0 && d.votes.length === 0 && d.avis === 0 && d.incidents.erreur + d.incidents.limite === 0;
  if (calme) lignes.push("", "<i>Aucune activité sur la période.</i>");
  return lignes.join("\n");
}

/** Coupe le rapport en messages de moins de `max` caractères, entre deux lignes. */
export function decouperMessages(texte: string, max = 4000): string[] {
  const messages: string[] = [];
  let courant = "";
  for (const ligne of texte.split("\n")) {
    const bloc = ligne.length > max ? `${ligne.slice(0, max - 1)}…` : ligne;
    if (courant && courant.length + bloc.length + 1 > max) {
      messages.push(courant);
      courant = "";
    }
    courant = courant ? `${courant}\n${bloc}` : bloc;
  }
  if (courant) messages.push(courant);
  return messages;
}

/** Version terminal : sans balises, entités décodées. */
export function enTexte(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
