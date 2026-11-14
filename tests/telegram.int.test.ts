/**
 * Le bot de bout en bout : vraie base Postgres (compteurs, mémoire), API Telegram simulée,
 * repondre() simulé. Webhook testé à travers Hono, comme sur le serveur Mastra.
 */
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RepondreResult } from "../src/aec/repondre.js";
import { INTROUVABLE_TEXTE } from "../src/aec/types.js";
import { ADMIN_MESSAGES, createBot, MAX_AVIS_PAR_JOUR, MESSAGES } from "../src/telegram/bot.js";
import { openChatId, pseudonymize, sealChatId } from "../src/telegram/privacy.js";
import { telegramWebhookHandler } from "../src/telegram/runtime.js";
import { BotStore } from "../src/telegram/store.js";

// Base dédiée aux tests : ses tables sont supprimées.
const DB = process.env.TEST_DATABASE_URL;
const SECRET = "p".repeat(32);
const USER_ID = 424242;
const botInfo = {
  id: 1, is_bot: true as const, first_name: "AECBot", username: "aecbot_test",
  can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false,
} as never;

describe.skipIf(!DB)("bot Telegram", () => {
  let pool: Pool;
  let store: BotStore;
  const sent: { method: string; payload: any }[] = [];
  const asked: { question: string; historique: unknown }[] = [];
  let nextAnswer: () => Promise<RepondreResult>;

  const answered = (texte: string): RepondreResult => ({
    reponse: {
      statut: "repondu", texte,
      sources: [{ n: 1, title: "PROGRAMME SITE 2025", url: "https://x/p.pdf", pages: [33], category: "programme", corpus: "aec2027", provisional: true }],
      avertissements: [],
      controle: { passagesRecuperes: 4, citationsValides: 1, citationsRejetees: 0, phrasesRetirees: 0, phrasesSansSource: 0 },
    },
    brut: texte, passages: [], usage: { inputTokens: 1000, outputTokens: 100 },
  });

  const logs: { msg: string; meta?: object }[] = [];
  const makeBot = (rate = 3) => {
    const bot = createBot("123:TEST", {
      repondre: async (question, opts) => {
        asked.push({ question, historique: opts?.historique });
        return nextAnswer();
      },
      store, pseudonymSecret: SECRET, ratePerHour: rate, memoryDays: 30,
      logger: { info: (msg, meta) => logs.push({ msg, meta }), error: (msg, meta) => logs.push({ msg, meta }) },
    }, botInfo);
    bot.api.config.use(async (_prev, method, payload) => {
      sent.push({ method, payload });
      return { ok: true, result: { message_id: sent.length, date: 0, chat: { id: USER_ID, type: "private" } } } as never;
    });
    return bot;
  };

  let updateId = 1;
  const message = (text: string, chatType = "private") => ({
    update_id: updateId++,
    message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000), text,
      chat: { id: USER_ID, type: chatType, first_name: "Militante" },
      from: { id: USER_ID, is_bot: false, first_name: "Militante" },
      ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {}),
    },
  });
  const replies = () => sent.filter((s) => s.method === "sendMessage").map((s) => s.payload.text as string);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB });
    await pool.query("DROP TABLE IF EXISTS aec_conversations; DROP TABLE IF EXISTS aec_rate_limit;");
    store = new BotStore(pool);
  });
  afterAll(() => pool.end());
  beforeEach(() => {
    sent.length = 0;
    asked.length = 0;
    logs.length = 0;
    nextAnswer = async () => answered("Retraite à 60 ans [1].");
  });

  it("répond en HTML, sans aperçu de lien, et montre qu'il écrit", async () => {
    await makeBot().handleUpdate(message("Et la retraite ?") as never);
    expect(sent.map((s) => s.method)).toEqual(["sendChatAction", "sendMessage"]);
    const reply = sent[1]!.payload;
    expect(reply).toMatchObject({ chat_id: USER_ID, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    expect(reply.text).toContain('Retraite à 60 ans [1].\n\n[1] <a href="https://x/p.pdf#page=33">');
  });

  it("ne stocke ni ne journalise l'identifiant Telegram, la question ou la réponse", async () => {
    await makeBot().handleUpdate(message("Et le SMIC ?") as never);
    const { rows } = await pool.query("SELECT pseudo, content FROM aec_conversations UNION ALL SELECT pseudo, '' FROM aec_rate_limit");
    expect(rows.every((r) => r.pseudo === pseudonymize(USER_ID, SECRET))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(String(USER_ID));
    expect(JSON.stringify(logs)).not.toMatch(new RegExp(`${USER_ID}|SMIC|Retraite`));
    expect(logs[0]).toMatchObject({ msg: "question traitée", meta: { statut: "repondu", inputTokens: 1000 } });
  });

  it("transmet les échanges récents pour les questions de suite", async () => {
    const bot = makeBot(100);
    await bot.handleUpdate(message("/oublier") as never);
    await bot.handleUpdate(message("Et la retraite ?") as never);
    await bot.handleUpdate(message("Et pour les carrières longues ?") as never);
    expect(asked[1]).toEqual({
      question: "Et pour les carrières longues ?",
      historique: [
        { role: "user", content: "Et la retraite ?" },
        { role: "assistant", content: "Retraite à 60 ans [1].\nSources : [1] Programme L'Avenir en commun p. 33" },
      ],
    });
  });

  it("/oublier efface la mémoire de la personne", async () => {
    const bot = makeBot(100);
    await bot.handleUpdate(message("Et la retraite ?") as never);
    await bot.handleUpdate(message("/oublier") as never);
    expect(replies().at(-1)).toBe(MESSAGES.oublie);
    expect(await store.history(pseudonymize(USER_ID, SECRET))).toEqual([]);
  });

  it("applique la limite par heure, sans appeler l'agent au-delà", async () => {
    const bot = makeBot(2);
    await bot.handleUpdate(message("/oublier") as never); // remet le compteur à zéro
    for (const q of ["Q1 ?", "Q2 ?", "Q3 ?"]) await bot.handleUpdate(message(q) as never);
    expect(asked.map((a) => a.question)).toEqual(["Q1 ?", "Q2 ?"]);
    expect(replies().at(-1)).toMatch(/^Tu as atteint la limite de 2 questions par heure\. Réessaie à partir de \d\d:00\.$/);
  });

  it("dit qu'il ne sait pas, et gère une panne sans exposer l'erreur", async () => {
    const bot = makeBot(100);
    nextAnswer = async () => ({
      ...answered(""),
      reponse: { ...answered("").reponse, statut: "introuvable", texte: INTROUVABLE_TEXTE, sources: [] },
    });
    await bot.handleUpdate(message("Et le Bitcoin ?") as never);
    expect(replies().at(-1)).toBe(`${INTROUVABLE_TEXTE}\n\n<i>Initiative non officielle, non endossée par LFI.</i>`);

    nextAnswer = async () => { throw new Error("Mistral HTTP 503 clé sk-secret"); };
    await bot.handleUpdate(message("Et la santé ?") as never);
    expect(replies().at(-1)).toBe(MESSAGES.erreur);
  });

  it("ignore les groupes, refuse les questions trop longues et les messages non texte", async () => {
    const bot = makeBot(100);
    await bot.handleUpdate(message("Et la retraite ?", "group") as never);
    expect(sent).toHaveLength(0);
    await bot.handleUpdate(message("x".repeat(501)) as never);
    expect(replies().at(-1)).toBe(MESSAGES.tropLong);
    const photo = message("ignored");
    delete (photo.message as { text?: string }).text;
    (photo.message as Record<string, unknown>).photo = [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }];
    await bot.handleUpdate(photo as never);
    expect(replies().at(-1)).toBe(MESSAGES.texteSeulement);
    expect(asked).toHaveLength(0);
  });

  it("/start présente le bot, la conservation des données et la limite", async () => {
    await makeBot(20).handleUpdate(message("/start") as never);
    expect(replies()[0]).toContain("sont gardés 30 jours, sous un pseudonyme");
    expect(replies()[0]).toContain("👍 ou 👎");
    expect(replies()[0]).toContain("/avis ton message");
    expect(replies()[0]).toContain("Limite : 20 questions par heure");
  });

  it("webhook : refuse un appel sans le secret, traite un appel signé", async () => {
    const app = new Hono();
    app.post("/telegram", telegramWebhookHandler(makeBot(100), "s3cret"));
    const body = JSON.stringify(message("Et la retraite ?"));
    const headers = { "content-type": "application/json" };

    const denied = await app.request("/telegram", { method: "POST", body, headers });
    expect(denied.status).toBe(401);
    expect(asked).toHaveLength(0);

    const ok = await app.request("/telegram", {
      method: "POST", body, headers: { ...headers, "x-telegram-bot-api-secret-token": "s3cret" },
    });
    expect(ok.status).toBe(200);
    expect(asked).toHaveLength(1);
  });

  describe("feedback 👍/👎", () => {
    const votes: { kind: string; traceId: string; spanId: string | null; pseudo: string; value?: number; comment?: string }[] = [];
    const forgotten: string[][] = [];
    const feedback = {
      vote: async (a: { traceId: string; spanId: string | null; pseudo: string; value: 1 | -1 }) =>
        void votes.push({ kind: "vote", ...a }),
      comment: async (a: { traceId: string; spanId: string | null; pseudo: string; comment: string }) =>
        void votes.push({ kind: "comment", ...a }),
      forgetTraces: async (ids: string[]) => void forgotten.push(ids),
    };
    const TRACE = "0123456789abcdef0123456789abcdef";
    const makeFbBot = () => {
      const bot = createBot("123:TEST", {
        repondre: async (question, opts) => {
          asked.push({ question, historique: opts?.historique });
          return { ...(await nextAnswer()), traceId: TRACE };
        },
        store, pseudonymSecret: SECRET, ratePerHour: 100, memoryDays: 30, feedback,
      }, botInfo);
      bot.api.config.use(async (_prev, method, payload) => {
        sent.push({ method, payload });
        return { ok: true, result: method === "answerCallbackQuery" || method === "editMessageReplyMarkup"
          ? true : { message_id: 500 + sent.length, date: 0, chat: { id: USER_ID, type: "private" } } } as never;
      });
      return bot;
    };
    const click = (data: string) => ({
      update_id: updateId++,
      callback_query: {
        id: `cb${updateId}`, chat_instance: "x", data,
        from: { id: USER_ID, is_bot: false, first_name: "Militante" },
        message: { message_id: 42, date: 0, chat: { id: USER_ID, type: "private" }, text: "réponse" },
      },
    });
    const pseudo = () => pseudonymize(USER_ID, SECRET);

    beforeEach(() => {
      votes.length = 0;
      forgotten.length = 0;
    });

    it("chaque réponse porte les boutons 👍/👎 liés à sa trace", async () => {
      await makeFbBot().handleUpdate(message("Et la retraite ?") as never);
      const reply = sent.find((x) => x.method === "sendMessage")!.payload;
      expect(reply.reply_markup.inline_keyboard[0]).toEqual([
        { text: "👍", callback_data: `fb:up:${TRACE}` },
        { text: "👎", callback_data: `fb:down:${TRACE}` },
      ]);
      expect(await store.ownsTrace(pseudo(), TRACE)).toBe(true);
    });

    it("👍 : vote enregistré sous pseudonyme, boutons retirés", async () => {
      const bot = makeFbBot();
      await bot.handleUpdate(message("Et la retraite ?") as never);
      sent.length = 0;
      await bot.handleUpdate(click(`fb:up:${TRACE}`) as never);
      expect(votes).toEqual([{ kind: "vote", traceId: TRACE, spanId: null, pseudo: pseudo(), value: 1 }]);
      expect(sent.map((x) => x.method)).toEqual(["answerCallbackQuery", "editMessageReplyMarkup"]);
      expect(sent[0]!.payload.text).toBe(MESSAGES.merci);
    });

    it("👎 puis commentaire en réponse : enregistré comme commentaire, sans compter comme question", async () => {
      const bot = makeFbBot();
      await bot.handleUpdate(message("Et le SMIC ?") as never);
      sent.length = 0;
      asked.length = 0;
      await bot.handleUpdate(click(`fb:down:${TRACE}`) as never);
      const prompt = sent.find((x) => x.method === "sendMessage")!;
      expect(prompt.payload).toMatchObject({ text: MESSAGES.demandeCommentaire, reply_markup: { force_reply: true } });
      const promptId = 500 + sent.indexOf(prompt) + 1;

      const reply = message("Le chiffre de 1 400 € est celui de 2022");
      (reply.message as Record<string, unknown>).reply_to_message = {
        message_id: promptId, date: 0, chat: { id: USER_ID, type: "private" }, text: MESSAGES.demandeCommentaire,
      };
      await bot.handleUpdate(reply as never);
      expect(votes).toEqual([
        { kind: "vote", traceId: TRACE, spanId: null, pseudo: pseudo(), value: -1 },
        { kind: "comment", traceId: TRACE, spanId: null, pseudo: pseudo(), comment: "Le chiffre de 1 400 € est celui de 2022" },
      ]);
      expect(asked).toHaveLength(0);
      expect(sent.at(-1)!.payload.text).toBe(MESSAGES.commentaireNote);
      // La demande est consommée : une seconde réponse au même message redevient une question.
      await bot.handleUpdate({ ...reply, update_id: updateId++ } as never);
      expect(asked).toHaveLength(1);
    });

    it("refuse un vote sur une trace qui n'a pas été donnée à cette personne", async () => {
      await makeFbBot().handleUpdate(click("fb:up:ffffffffffffffffffffffffffffffff") as never);
      expect(votes).toEqual([]);
      expect(sent.at(-1)).toMatchObject({ method: "answerCallbackQuery", payload: { text: MESSAGES.voteExpire } });
    });

    it("/oublier efface aussi les traces (et donc les votes)", async () => {
      const bot = makeFbBot();
      await bot.handleUpdate(message("Et la retraite ?") as never);
      await bot.handleUpdate(message("/oublier") as never);
      expect(forgotten).toEqual([[TRACE]]);
      expect(await store.ownsTrace(pseudo(), TRACE)).toBe(false);
    });
  });

  describe("gestion du corpus par l'équipe", () => {
    const TEAM_ID = 777;
    const calls: { op: string; args: any }[] = [];
    const admin = {
      ajouter: async (a: any) => {
        calls.push({ op: "ajouter", args: { ...a, pdf: a.pdf ? Array.from(a.pdf) : undefined } });
        return { id: "manual:3f2a9c1b-0000", title: a.title, status: "indexé" as const, category: "ajout_manuel" as const, passages: 12, detail: "" };
      },
      lister: async () => [
        { id: "manual:3f2a9c1b-0000", title: "Note <interne>", included: true, reason: "", passages: 12, addedBy: "Camille (u_x)", indexedAt: "2026-11-14T10:00:00Z" },
        { id: "manual:aa11bb22-0000", title: "Scan", included: false, reason: "Extraction non exploitable", passages: 0, addedBy: "Camille (u_x)", indexedAt: "2026-11-14T11:00:00Z" },
      ],
      supprimer: async (id: string, who: string) => {
        calls.push({ op: "supprimer", args: { id, who } });
        return { id: "manual:3f2a9c1b-0000", title: "Note <interne>" };
      },
      telecharger: async (fileId: string) => {
        calls.push({ op: "telecharger", args: fileId });
        return new Uint8Array([1, 2, 3]);
      },
    };
    const makeAdminBot = () => {
      const bot = createBot("123:TEST", {
        repondre: async () => nextAnswer(), store, pseudonymSecret: SECRET, ratePerHour: 100, memoryDays: 30,
        team: new Set([TEAM_ID]), admin,
      }, botInfo);
      bot.api.config.use(async (_prev, method, payload) => {
        sent.push({ method, payload });
        return { ok: true, result: { message_id: 900 + sent.length, date: 0, chat: { id: TEAM_ID, type: "private" } } } as never;
      });
      return bot;
    };
    const from = (id: number, text: string, extra: Record<string, unknown> = {}) => {
      const m = message(text) as any;
      m.message.from = { id, is_bot: false, first_name: "Camille" };
      m.message.chat = { id, type: "private", first_name: "Camille" };
      Object.assign(m.message, extra);
      return m;
    };
    beforeEach(() => void (calls.length = 0));

    it("refuse les commandes d'équipe à un militant", async () => {
      const bot = makeAdminBot();
      for (const cmd of ["/ajouter https://x.fr/a.pdf Titre", "/docs", "/supprimer 3f2a9c1b"]) {
        await bot.handleUpdate(from(USER_ID, cmd) as never);
        expect(replies().at(-1)).toBe(ADMIN_MESSAGES.reserve);
      }
      expect(calls).toEqual([]);
    });

    it("/ajouter : un lien, un texte, et l'aide si la commande est incomplète", async () => {
      const bot = makeAdminBot();
      await bot.handleUpdate(from(TEAM_ID, "/ajouter https://exemple.fr/tribune.pdf Tribune sur les retraites") as never);
      await bot.handleUpdate(from(TEAM_ID, "/ajouter Mémo transports\nLa gratuité des transports est proposée.\nDeuxième ligne.") as never);
      expect(calls.map((c) => c.args)).toEqual([
        { title: "Tribune sur les retraites", url: "https://exemple.fr/tribune.pdf", addedBy: expect.stringMatching(/^Camille \(u_/), pdf: undefined },
        { title: "Mémo transports", text: "La gratuité des transports est proposée.\nDeuxième ligne.", addedBy: expect.any(String), pdf: undefined },
      ]);
      expect(replies().at(-1)).toBe("Ajouté : « Mémo transports », 12 passages (identifiant <code>3f2a9c1b</code>).");
      await bot.handleUpdate(from(TEAM_ID, "/ajouter Titre sans contenu") as never);
      expect(replies().at(-1)).toBe(ADMIN_MESSAGES.aide);
    });

    it("/ajouter : un PDF envoyé avec la légende", async () => {
      const bot = makeAdminBot();
      const doc = from(TEAM_ID, "", {
        document: { file_id: "FILE1", file_unique_id: "U1", file_name: "note.pdf", mime_type: "application/pdf" },
        caption: "/ajouter Note interne",
        caption_entities: [{ type: "bot_command", offset: 0, length: 8 }],
      });
      delete doc.message.text;
      delete doc.message.entities;
      await bot.handleUpdate(doc as never);
      expect(calls).toEqual([
        { op: "telecharger", args: "FILE1" },
        { op: "ajouter", args: { title: "Note interne", pdf: [1, 2, 3], addedBy: expect.any(String), telegramFileId: "FILE1" } },
      ]);
      const notPdf = from(TEAM_ID, "", { document: { file_id: "F2", file_unique_id: "U2", mime_type: "image/png" }, caption: "/ajouter Image" });
      delete notPdf.message.text;
      delete notPdf.message.entities;
      await bot.handleUpdate(notPdf as never);
      expect(replies().at(-1)).toBe(ADMIN_MESSAGES.pasPdf);
    });

    it("/docs liste les documents, /supprimer en retire un", async () => {
      const bot = makeAdminBot();
      await bot.handleUpdate(from(TEAM_ID, "/docs") as never);
      const list = replies().at(-1)!;
      expect(list).toContain("<code>3f2a9c1b</code> Note &lt;interne&gt; — 12 passages, 14/11/2026, Camille");
      expect(list).toContain("<code>aa11bb22</code> Scan — écarté : Extraction non exploitable");
      await bot.handleUpdate(from(TEAM_ID, "/supprimer 3f2a9c1b") as never);
      expect(calls.at(-1)).toEqual({ op: "supprimer", args: { id: "3f2a9c1b", who: expect.stringMatching(/^Camille/) } });
      expect(replies().at(-1)).toBe("Retiré du corpus : « Note &lt;interne&gt; ».");
    });
  });

  it("purge : efface les conversations trop anciennes", async () => {
    const pseudo = pseudonymize(USER_ID, SECRET);
    await store.append(pseudo, "vieille question", "vieille réponse");
    await pool.query("UPDATE aec_conversations SET created_at = now() - interval '31 days' WHERE content LIKE 'vieille%'");
    const res = await store.purge(30);
    expect(res.messages).toBe(2);
    const { rows } = await pool.query("SELECT count(*)::int n FROM aec_conversations WHERE content LIKE 'vieille%'");
    expect(rows[0].n).toBe(0);
  });
  describe("avis généraux et réponses de l'équipe", () => {
    const TEAM_ID = 777;
    let ids = 2000;
    const out: { method: string; payload: any; id: number }[] = [];
    const makeAvisBot = () => {
      const bot = createBot("123:TEST", {
        repondre: async (question, opts) => {
          asked.push({ question, historique: opts?.historique });
          return nextAnswer();
        },
        store, pseudonymSecret: SECRET, ratePerHour: 100, memoryDays: 30, team: new Set([TEAM_ID]),
      }, botInfo);
      bot.api.config.use(async (_prev, method, payload: any) => {
        const id = ++ids;
        out.push({ method, payload, id });
        return { ok: true, result: { message_id: id, date: 0, chat: { id: payload.chat_id, type: "private" } } } as never;
      });
      return bot;
    };
    const msg = (fromId: number, text: string, replyTo?: { id: number; text?: string }) => {
      const m = message(text) as any;
      m.message.from = { id: fromId, is_bot: false, first_name: "X" };
      m.message.chat = { id: fromId, type: "private", first_name: "X" };
      if (replyTo) m.message.reply_to_message = { message_id: replyTo.id, date: 0, chat: m.message.chat, text: replyTo.text };
      return m;
    };
    const to = (chatId: number) => out.filter((o) => o.method === "sendMessage" && o.payload.chat_id === chatId);

    beforeAll(async () => {
      await pool.query("DROP TABLE IF EXISTS aec_avis_notifs; DROP TABLE IF EXISTS aec_avis; DROP TABLE IF EXISTS aec_avis_prompts;");
      // Le store a déjà créé ses tables : on le force à les recréer.
      store = new BotStore(pool);
    });
    beforeEach(() => void (out.length = 0));

    it("chiffre l'identifiant de discussion de façon réversible avec le seul secret", () => {
      const sealed = sealChatId(USER_ID, SECRET);
      expect(sealed).not.toContain(String(USER_ID));
      expect(sealChatId(USER_ID, SECRET)).not.toBe(sealed); // IV aléatoire
      expect(openChatId(sealed, SECRET)).toBe(USER_ID);
      expect(() => openChatId(sealed, "q".repeat(32))).toThrow();
    });

    it("/avis puis réponse : enregistré, transmis à l'équipe, sans compter comme question", async () => {
      const bot = makeAvisBot();
      await bot.handleUpdate(msg(USER_ID, "/avis") as never);
      const prompt = to(USER_ID).at(-1)!;
      expect(prompt.payload).toMatchObject({ text: MESSAGES.demandeAvis, reply_markup: { force_reply: true } });

      await bot.handleUpdate(msg(USER_ID, "Il manque le <b>logement</b>", { id: prompt.id }) as never);
      expect(asked).toEqual([]);
      expect(to(USER_ID).at(-1)!.payload.text).toBe(MESSAGES.avisNote);
      const notif = to(TEAM_ID).at(-1)!.payload.text as string;
      expect(notif).toMatch(/^💬 <b>Avis n° \d+<\/b>/);
      expect(notif).toContain("Il manque le &lt;b&gt;logement&lt;/b&gt;");
      expect(notif).not.toContain(String(USER_ID));

      const { rows } = await pool.query("SELECT pseudo, texte, chat_sealed FROM aec_avis");
      expect(rows).toHaveLength(1);
      expect(rows[0].pseudo).toBe(pseudonymize(USER_ID, SECRET));
      expect(JSON.stringify(rows)).not.toContain(String(USER_ID));
    });

    it("l'équipe répond à la notification, la personne répond à son tour", async () => {
      const bot = makeAvisBot();
      await bot.handleUpdate(msg(USER_ID, "/avis Super bot") as never);
      const notif = to(TEAM_ID).at(-1)!;

      await bot.handleUpdate(msg(TEAM_ID, "Merci, on ajoute le logement bientôt", { id: notif.id, text: "💬 Avis n° 2" }) as never);
      const reponse = to(USER_ID).at(-1)!;
      expect(reponse.payload.text).toContain("Réponse de l'équipe");
      expect(reponse.payload.text).toContain("Merci, on ajoute le logement bientôt");
      expect(reponse.payload.reply_markup).toMatchObject({ force_reply: true });
      expect(to(TEAM_ID).at(-1)!.payload.text).toMatch(/^Réponse envoyée/);
      expect(asked).toEqual([]);

      // Sa réponse redevient un avis, transmis à l'équipe.
      await bot.handleUpdate(msg(USER_ID, "Top, merci !", { id: reponse.id }) as never);
      expect(to(TEAM_ID).at(-1)!.payload.text).toContain("Top, merci !");
      expect(asked).toEqual([]);
    });

    it("/repondre : réservé à l'équipe, par numéro d'avis", async () => {
      const bot = makeAvisBot();
      await bot.handleUpdate(msg(USER_ID, "/avis Une idée") as never);
      const n = /Avis n° (\d+)/.exec(to(TEAM_ID).at(-1)!.payload.text)![1];
      await bot.handleUpdate(msg(USER_ID, `/repondre ${n} coucou`) as never);
      expect(to(USER_ID).at(-1)!.payload.text).toBe(ADMIN_MESSAGES.reserve);
      await bot.handleUpdate(msg(TEAM_ID, `/repondre ${n} Bonne idée`) as never);
      expect(to(USER_ID).at(-1)!.payload.text).toContain("Bonne idée");
      await bot.handleUpdate(msg(TEAM_ID, "/repondre 999999 rien") as never);
      expect(to(TEAM_ID).at(-1)!.payload.text).toMatch(/^Avis introuvable/);
    });

    it("limite le nombre d'avis par jour", async () => {
      await pool.query("DELETE FROM aec_avis");
      const bot = makeAvisBot();
      for (let i = 0; i < MAX_AVIS_PAR_JOUR + 1; i++) await bot.handleUpdate(msg(USER_ID, `/avis n${i}`) as never);
      expect(to(USER_ID).at(-1)!.payload.text).toBe(MESSAGES.avisLimite);
      expect(to(TEAM_ID)).toHaveLength(MAX_AVIS_PAR_JOUR);
    });

    it("/oublier efface les avis : l'équipe ne peut plus répondre", async () => {
      const bot = makeAvisBot();
      await pool.query("DELETE FROM aec_avis");
      await bot.handleUpdate(msg(USER_ID, "/avis À effacer") as never);
      const notif = to(TEAM_ID).at(-1)!;
      await bot.handleUpdate(msg(USER_ID, "/oublier") as never);
      const { rows } = await pool.query("SELECT count(*)::int n FROM aec_avis");
      expect(rows[0].n).toBe(0);
      // Telegram renvoie le texte rendu, sans balises.
      await bot.handleUpdate(msg(TEAM_ID, "Réponse", { id: notif.id, text: notif.payload.text.replace(/<[^>]+>/g, "") }) as never);
      expect(to(TEAM_ID).at(-1)!.payload.text).toMatch(/^Avis introuvable/);
      expect(asked).toEqual([]);
    });

    it("purge : efface les avis trop anciens", async () => {
      await store.addAvis("u_vieux", "vieil avis");
      await pool.query("UPDATE aec_avis SET created_at = now() - interval '31 days' WHERE texte = 'vieil avis'");
      expect((await store.purge(30)).avis).toBe(1);
    });
  });
});
