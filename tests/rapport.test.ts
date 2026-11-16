import { describe, expect, it } from "vitest";
import { collecterRapport, decouperMessages, enTexte, formatRapport, type DonneesRapport } from "../src/telegram/rapport.js";
import type { EchangeRapport, ReponseMeta } from "../src/telegram/store.js";

const meta = (over: Partial<ReponseMeta> = {}): ReponseMeta => ({
  statut: "repondu", origine: "question", sources: 2, citationsRejetees: 0, phrasesRetirees: 0,
  inputTokens: 10_000, outputTokens: 300, ms: 4000, ...over,
});
const ex = (question: string, pseudo: string, m?: Partial<ReponseMeta> | null, answer = "Réponse [1]."): EchangeRapport => ({
  pseudo, question, answer, traceId: `t-${question}`, createdAt: new Date("2026-11-16T10:00:00Z"),
  ...(m === null ? {} : { meta: meta(m) }),
});
const base = (over: Partial<DonneesRapport> = {}): DonneesRapport => ({
  depuis: new Date("2026-11-15T07:00:00Z"), jusqua: new Date("2026-11-16T07:00:00Z"),
  echanges: [], incidents: { erreur: 0, limite: 0 }, avis: 0, votes: [], echangesVotes: new Map(), ...over,
});

describe("formatRapport", () => {
  const d = base({
    echanges: [
      ex("Et la retraite ?", "u_aaaaaaaaaaaaaaaa", { ms: 3000 }),
      ex("Et le SMIC ?", "u_aaaaaaaaaaaaaaaa", { origine: "suite", ms: 5000, citationsRejetees: 2 }),
      ex("Et les 80 km/h ?", "u_bbbbbbbbbbbbbbbb", { statut: "introuvable", objet: "non", sources: 0 }),
      ex("Et la corrida ?", "u_bbbbbbbbbbbbbbbb", { objet: "oui", ms: 9000 }),
      // Échange d'avant le déploiement : pas de meta, statut déduit de la réponse gardée en mémoire.
      ex("Et TikTok ?", "u_cccccccccccccccc", null, "Rien trouvé dans le corpus."),
    ],
    incidents: { erreur: 1, limite: 3 },
    avis: 2,
    votes: [
      { traceId: "t-Et la retraite ?", feedbackType: "thumbs", value: 1, timestamp: "2026-11-16T06:00:00Z" },
      { traceId: "t-vieille", feedbackType: "thumbs", value: -1, timestamp: "2026-11-16T06:00:00Z" },
      { traceId: "t-vieille", feedbackType: "comment", value: "Il manque le livret santé", timestamp: "2026-11-16T06:01:00Z" },
      { traceId: "t-effacee", feedbackType: "thumbs", value: -1, timestamp: "2026-11-16T06:02:00Z" },
    ],
    echangesVotes: new Map([["t-vieille", { question: "Et l'hôpital ?", answer: "Le programme prévoit…\nSources : [1]" }]]),
  });
  const html = formatRapport(d);

  it("donne les volumes, les taux et le coût", () => {
    expect(html).toContain("du 15/11 08:00 au 16/11 08:00"); // heure de Paris
    expect(html).toContain("<b>5</b> questions de <b>3</b> personnes (dont 1 suite choisie)");
    expect(html).toContain("répondues : 3 · ❔ introuvables : 2 (40 %)");
    expect(html).toContain("réponses partielles contrôlées : 2, dont 1 écartée");
    expect(html).toContain("citations inventées rejetées : 2 (dans 1 réponse)");
    expect(html).toContain("👍 1 · 👎 2 · 💬 1 commentaire · avis /avis : 2");
    expect(html).toContain("pannes : 1 · refus pour limite horaire : 3");
    expect(html).toContain("médiane 5,0 s, max 9,0 s");
    expect(html).toContain("10 000+300 par question");
  });

  it("liste les questions à revoir, avec le pseudonyme tronqué", () => {
    expect(html).toContain("• « Et les 80 km/h ? » <code>u_bbbbbbbb</code> <i>(écartée par le contrôle)</i>");
    expect(html).toContain("• « Et TikTok ? » <code>u_cccccccc</code>");
    expect(html).toContain("• 👎 « Et l'hôpital ? »\n   → Le programme prévoit… Sources : [1]\n   💬 « Il manque le livret santé »");
    expect(html).toContain("• 👎 <i>(question et réponse plus en mémoire)</i>");
    expect(html).toContain("• « Et le SMIC ? » (2)");
    expect(html).not.toContain("u_aaaaaaaaaaaaaaaa");
  });

  it("coupe les listes trop longues et renvoie à la commande", () => {
    const beaucoup = base({ echanges: Array.from({ length: 13 }, (_, i) => ex(`Q${i} ?`, "u_x", { statut: "introuvable" })) });
    const h = formatRapport(beaucoup, { maxParListe: 10 });
    expect(h).toContain("• « Q9 ? »");
    expect(h).not.toContain("• « Q10 ? »");
    expect(h).toContain("… et 3 autre(s) : pnpm rapport:prod");
  });

  it("le dit quand il ne s'est rien passé", () => {
    expect(formatRapport(base())).toContain("Aucune activité sur la période.");
    expect(formatRapport(base({ incidents: { erreur: 1, limite: 0 } }))).not.toContain("Aucune activité");
  });
});

describe("collecterRapport", () => {
  it("ne garde que les votes de la période et relit leurs échanges", async () => {
    const vus: string[][] = [];
    const d = await collecterRapport(
      {
        store: {
          echangesEntre: async () => [],
          incidentsEntre: async () => ({ erreur: 0, limite: 0 }),
          avisEntre: async () => 0,
          exchanges: async (traces: string[]) => (vus.push(traces), new Map()),
        },
        votesDepuis: async () => [
          { traceId: "a", feedbackType: "thumbs", value: -1, timestamp: "2026-11-16T06:00:00Z" },
          { traceId: "b", feedbackType: "thumbs", value: -1, timestamp: "2026-11-16T08:00:00Z" }, // après la période
        ],
      },
      new Date("2026-11-15T07:00:00Z"),
      new Date("2026-11-16T07:00:00Z"),
    );
    expect(d.votes.map((v) => v.traceId)).toEqual(["a"]);
    expect(vus).toEqual([["a"]]);
  });
});

describe("decouperMessages", () => {
  it("coupe entre deux lignes, sous la limite de Telegram", () => {
    const texte = Array.from({ length: 100 }, (_, i) => `ligne ${i} ${"x".repeat(80)}`).join("\n");
    const parts = decouperMessages(texte, 1000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join("\n")).toBe(texte);
  });
});

describe("enTexte", () => {
  it("retire les balises et décode les entités", () => {
    expect(enTexte("<b>2</b> « Et le &lt;Bitcoin&gt; ? » &amp; co")).toBe("2 « Et le <Bitcoin> ? » & co");
  });
});
