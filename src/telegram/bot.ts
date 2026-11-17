import { Bot, InlineKeyboard, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { repondre as repondreFn } from "../aec/repondre.js";
import { answerForMemory, DISCLAIMER, escapeHtml, formatAnswer } from "./format.js";
import { openChatId, pseudonymize, sealChatId } from "./privacy.js";
import type { DocumentResult } from "../corpus/schemas.js";
import type { FeedbackSink } from "./feedback.js";
import type { BotStore } from "./store.js";

export interface BotDeps {
  repondre: typeof repondreFn;
  store: BotStore;
  pseudonymSecret: string;
  ratePerHour: number;
  memoryDays: number;
  /** Absent : pas de boutons 👍/👎. */
  feedback?: FeedbackSink;
  /** Identifiants Telegram de l'équipe : seuls eux peuvent /ajouter, /docs, /supprimer. */
  team?: Set<number>;
  admin?: AdminOps;
  /** Jetons de l'extension de capture (src/argu/jetons.ts en production). */
  argu?: ArguOps;
  logger?: { info: (msg: string, meta?: object) => void; error: (msg: string, meta?: object) => void };
}

const MAX_QUESTION = 500;

export const MESSAGES = {
  bienvenue: (memoryDays: number, rate: number) =>
    [
      "Bonjour ! Je réponds à tes questions sur le programme <b>L'Avenir en commun</b>, ses livrets et ses plans.",
      "Je cherche dans les documents publiés et je cite chaque source avec sa page. Si je ne trouve pas, je te le dis plutôt que d'inventer.",
      "Exemple : <i>Qu'est-ce que le programme dit sur la retraite ?</i>\nSous chaque réponse, je te propose des questions numérotées pour aller plus loin : touche un numéro ou envoie-le.",
      [
        "<b>Aide-nous à améliorer le bot</b>",
        "• <b>Sur une réponse</b> : touche 👍 ou 👎 juste en dessous. Après un 👎, je te demande ce qui n'allait pas : réponds à ce message pour l'expliquer (facultatif).",
        "• <b>Sur le bot en général</b> (une idée, un sujet qui manque, un problème) : envoie /avis puis ton message, ou directement <code>/avis ton message</code>. L'équipe le lit et peut te répondre ici.",
      ].join("\n"),
      `Tes questions, les réponses et tes avis sont gardés ${memoryDays} jours, sous un pseudonyme, pour comprendre les questions de suite et corriger les erreurs (avec un avis, on garde aussi, chiffré, de quoi te répondre). /oublier efface tout. Limite : ${rate} questions par heure.`,
      "Ce bot est un outil militant, fait par et pour les insoumis·es. Une idée pour le renforcer, envie de filer un coup de main ? Écris-moi directement : @etiennepie ✊",
      `<i>${escapeHtml(DISCLAIMER)}</i>`,
    ].join("\n\n"),
  oublie: "C'est fait : tes échanges avec moi sont effacés.",
  tropLong: `Ta question est trop longue (${MAX_QUESTION} caractères au plus). Peux-tu la raccourcir ?`,
  texteSeulement: "Je ne lis que les messages texte. Pose-moi ta question par écrit.",
  limite: (rate: number, reset: Date) =>
    `Tu as atteint la limite de ${rate} questions par heure. Réessaie à partir de ${reset.toLocaleTimeString("fr-FR", {
      timeZone: "Europe/Paris",
      hour: "2-digit",
      minute: "2-digit",
    })}.`,
  erreur: "Désolé, je n'arrive pas à répondre pour le moment. Réessaie dans quelques minutes.",
  merci: "Merci pour ton avis !",
  demandeCommentaire: "Merci. Qu'est-ce qui n'allait pas ? Réponds à ce message si tu veux préciser (facultatif).",
  commentaireNote: "Merci, c'est noté. Ça nous aide à corriger le bot.",
  voteExpire: "Ce vote n'est plus disponible.",
  suiteExpiree: "Cette suggestion n'est plus disponible : pose ta question directement.",
  demandeAvis:
    "Qu'est-ce que tu penses du bot ? Une idée, un manque, un problème : réponds à ce message, l'équipe le lira et pourra te répondre ici.",
  avisNote: "Merci, ton avis est transmis à l'équipe. Elle pourra te répondre ici.",
  reponseEquipe: (texte: string) =>
    `💬 <b>Réponse de l'équipe</b>\n\n${escapeHtml(texte)}\n\n<i>Réponds à ce message pour continuer l'échange.</i>`,
  avisLimite: "Merci ! Tu as déjà envoyé plusieurs avis aujourd'hui : réessaie demain.",
};

/** Avis par personne et par 24 heures : chacun est transmis à l'équipe, on évite d'inonder. */
export const MAX_AVIS_PAR_JOUR = 5;

const MAX_COMMENT = 1000;

/** Opérations de gestion du corpus (src/corpus/manual.ts en production). */
export interface AdminOps {
  ajouter(a: { title: string; url?: string; text?: string; pdf?: Uint8Array; addedBy: string; telegramFileId?: string }): Promise<DocumentResult>;
  lister(): Promise<{ id: string; title: string; included: boolean; reason: string; passages: number; addedBy: string | null; indexedAt: string }[]>;
  supprimer(id: string, who: string): Promise<{ id: string; title: string }>;
  /** Télécharge un fichier envoyé au bot. */
  telecharger(fileId: string): Promise<Uint8Array>;
}

/** Jetons personnels de l'extension de capture, rattachés au pseudonyme du membre. */
export interface ArguOps {
  creerJeton(pseudo: string): Promise<string>;
  revoquerJetons(pseudo: string): Promise<number>;
}

export const JETON_MESSAGES = {
  nouveau: (jeton: string) =>
    [
      "🔑 <b>Ton jeton pour l'extension de capture</b>",
      `<code>${escapeHtml(jeton)}</code>`,
      "Colle-le une fois dans les réglages de l'extension. Il n'est pas conservé en clair : je ne pourrai pas te le redonner.",
      "Ton jeton précédent, s'il y en avait un, ne marche plus. <code>/jeton revoquer</code> l'invalide si tu le perds.",
      "<i>Tu peux supprimer ce message une fois le jeton copié.</i>",
    ].join("\n\n"),
  revoque: (n: number) => (n ? "Jeton révoqué : l'extension ne peut plus envoyer de captures en ton nom." : "Tu n'avais aucun jeton actif."),
};

export const ADMIN_MESSAGES = {
  reserve: "Cette commande est réservée à l'équipe.",
  aide: [
    "<b>Ajouter un document au corpus</b>",
    "• un PDF : envoie le fichier avec la légende <code>/ajouter Titre du document</code>",
    "• un lien (PDF ou page web) : <code>/ajouter https://… Titre du document</code>",
    "• un texte : <code>/ajouter Titre du document</code>, puis le texte sur les lignes suivantes, dans le même message",
    "",
    "/docs liste les documents ajoutés ; <code>/supprimer identifiant</code> en retire un.",
    "",
    "<b>Extension de capture</b> : /jeton te donne ton jeton personnel ; <code>/jeton revoquer</code> l'invalide.",
    "",
    "<b>Avis des militants</b> : chaque avis t'arrive ici. Réponds au message (ou <code>/repondre numéro texte</code>) pour répondre à la personne.",
    "Le document est utilisable tout de suite, sans relecture : vérifie-le avant de l'ajouter.",
  ].join("\n"),
  enCours: "Ajout en cours…",
  pasPdf: "Je n'accepte que les fichiers PDF.",
};

function shortDocId(id: string): string {
  return id.replace(/^manual:/, "").slice(0, 8);
}

function describeResult(title: string, r: DocumentResult): string {
  if (r.status === "indexé") {
    return `Ajouté : « ${escapeHtml(title)} », ${r.passages} passages (identifiant <code>${shortDocId(r.id)}</code>).`;
  }
  if (r.status === "écarté") return `Non ajouté : ${escapeHtml(r.detail || "document écarté")}.`;
  return `Échec de l'ajout : ${escapeHtml(r.detail || "erreur inconnue")}.`;
}

/** « /ajouter https://… Titre » ou « /ajouter Titre » + texte sur les lignes suivantes. */
export function parseAjouter(arg: string): { title: string; url?: string; text?: string } | undefined {
  const [first = "", ...rest] = arg.split("\n");
  const line = first.trim();
  const url = /^https?:\/\/\S+/.exec(line)?.[0];
  if (url) {
    const title = line.slice(url.length).trim();
    return title ? { title, url } : undefined;
  }
  const text = rest.join("\n").trim();
  return line && text ? { title: line, text } : undefined;
}

/** Sous une réponse : 👍/👎 (si le feedback est branché), puis un bouton par suite proposée. */
function answerKeyboard(traceId: string, opts: { votes: boolean; suites: string[] }): InlineKeyboard | undefined {
  const kb = new InlineKeyboard();
  if (opts.votes) kb.text("👍", `fb:up:${traceId}`).text("👎", `fb:down:${traceId}`).row();
  opts.suites.forEach((_q, i) => kb.text(String(i + 1), `sx:${i + 1}:${traceId}`));
  return kb.inline_keyboard.flat().length ? kb : undefined;
}

/** « 2 », « 2. » ou « 2) » envoyé seul : le choix d'une suite proposée. */
export function parseChoix(text: string): number | undefined {
  const m = /^\s*([1-9])\s*[.)]?\s*$/.exec(text);
  return m ? Number(m[1]) : undefined;
}

/**
 * Bot des militants : messages privés uniquement. Les commandes de l'équipe
 * (/ajouter, /docs, /supprimer) viendront à l'étape 4.
 */
export function createBot(token: string, deps: BotDeps, botInfo?: UserFromGetMe): Bot {
  const bot = new Bot(token, botInfo ? { botInfo } : {});
  const log = deps.logger;

  // Groupes et canaux ignorés : le bot ne parle qu'en privé.
  bot.filter((ctx) => ctx.chat?.type !== "private").use(() => {});

  bot.command(["start", "aide"], (ctx) =>
    ctx.reply(MESSAGES.bienvenue(deps.memoryDays, deps.ratePerHour), { parse_mode: "HTML" }),
  );

  // --- Gestion du corpus par l'équipe ------------------------------------------------
  const teamMember = (ctx: Context) => !!ctx.from && !!deps.team?.has(ctx.from.id) && !!deps.admin;
  const who = (ctx: Context) => `${ctx.from?.first_name ?? "?"} (${pseudoOf(ctx, deps) ?? "?"})`;
  const adminError = async (ctx: Context, e: unknown) => {
    log?.error("échec d'une commande d'équipe", { erreur: e instanceof Error ? e.message : String(e) });
    await ctx.reply(`Échec : ${escapeHtml(e instanceof Error ? e.message : String(e))}`, { parse_mode: "HTML" });
  };

  bot.command("ajouter", async (ctx) => {
    if (!teamMember(ctx)) return void (await ctx.reply(ADMIN_MESSAGES.reserve));
    const parsed = parseAjouter(String(ctx.match ?? ""));
    if (!parsed) return void (await ctx.reply(ADMIN_MESSAGES.aide, { parse_mode: "HTML" }));
    await ctx.reply(ADMIN_MESSAGES.enCours);
    try {
      const r = await deps.admin!.ajouter({ ...parsed, addedBy: who(ctx) });
      await ctx.reply(describeResult(parsed.title, r), { parse_mode: "HTML" });
    } catch (e) {
      await adminError(ctx, e);
    }
  });

  // Un PDF envoyé avec la légende « /ajouter Titre ».
  bot.on("message:document", async (ctx, next) => {
    const caption = ctx.message.caption?.trim() ?? "";
    if (!/^\/ajouter(@\w+)?\b/i.test(caption)) return next();
    if (!teamMember(ctx)) return void (await ctx.reply(ADMIN_MESSAGES.reserve));
    const doc = ctx.message.document;
    if (doc.mime_type !== "application/pdf") return void (await ctx.reply(ADMIN_MESSAGES.pasPdf));
    const title = caption.replace(/^\/ajouter(@\w+)?/i, "").trim() || (doc.file_name ?? "").replace(/\.pdf$/i, "");
    await ctx.reply(ADMIN_MESSAGES.enCours);
    try {
      const pdf = await deps.admin!.telecharger(doc.file_id);
      const r = await deps.admin!.ajouter({ title, pdf, addedBy: who(ctx), telegramFileId: doc.file_id });
      await ctx.reply(describeResult(title, r), { parse_mode: "HTML" });
    } catch (e) {
      await adminError(ctx, e);
    }
  });

  bot.command("docs", async (ctx) => {
    if (!teamMember(ctx)) return void (await ctx.reply(ADMIN_MESSAGES.reserve));
    try {
      const docs = await deps.admin!.lister();
      if (docs.length === 0) return void (await ctx.reply("Aucun document ajouté à la main pour l'instant."));
      const lines = docs.slice(0, 40).map((d) => {
        const date = new Date(d.indexedAt).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" });
        const etat = d.included ? `${d.passages} passages` : `écarté : ${d.reason}`;
        return `<code>${shortDocId(d.id)}</code> ${escapeHtml(d.title)} — ${escapeHtml(etat)}, ${date}${d.addedBy ? `, ${escapeHtml(d.addedBy.split(" (")[0]!)}` : ""}`;
      });
      await ctx.reply([`<b>${docs.length} document(s) ajouté(s)</b>`, ...lines].join("\n"), { parse_mode: "HTML" });
    } catch (e) {
      await adminError(ctx, e);
    }
  });

  bot.command("supprimer", async (ctx) => {
    if (!teamMember(ctx)) return void (await ctx.reply(ADMIN_MESSAGES.reserve));
    const id = String(ctx.match ?? "").trim();
    if (!id) return void (await ctx.reply("Usage : <code>/supprimer identifiant</code> (voir /docs).", { parse_mode: "HTML" }));
    try {
      const d = await deps.admin!.supprimer(id, who(ctx));
      await ctx.reply(`Retiré du corpus : « ${escapeHtml(d.title)} ».`, { parse_mode: "HTML" });
    } catch (e) {
      await adminError(ctx, e);
    }
  });

  // --- Avis général sur le bot ------------------------------------------------------------
  const enregistrerAvis = async (ctx: Context, pseudo: string, texte: string) => {
    if ((await deps.store.avisRecents(pseudo)) >= MAX_AVIS_PAR_JOUR) return void (await ctx.reply(MESSAGES.avisLimite));
    // L'identifiant de discussion n'est gardé que chiffré, avec l'avis, pour que l'équipe puisse répondre.
    const id = await deps.store.addAvis(pseudo, texte.slice(0, MAX_COMMENT), sealChatId(ctx.chat!.id, deps.pseudonymSecret));
    log?.info("avis reçu", { pseudo, id });
    await ctx.reply(MESSAGES.avisNote);
    // L'équipe est prévenue sous le pseudonyme : jamais le nom ni l'identifiant Telegram.
    const notif = [
      `💬 <b>Avis n° ${id}</b> (<code>${pseudo.slice(0, 10)}</code>)`,
      escapeHtml(texte.slice(0, MAX_COMMENT)),
      "<i>Réponds à ce message pour répondre à la personne.</i>",
    ].join("\n\n");
    for (const member of deps.team ?? []) {
      try {
        const sent = await ctx.api.sendMessage(member, notif, { parse_mode: "HTML" });
        await deps.store.addAvisNotif(member, sent.message_id, id);
      } catch (e) {
        // Un membre qui n'a jamais écrit au bot ne peut pas recevoir de message : on continue.
        log?.error("avis non transmis à un membre de l'équipe", { erreur: e instanceof Error ? e.message : String(e) });
      }
    }
  };

  /** Un membre de l'équipe répond à un avis : le message part à la personne, sous la signature « l'équipe ». */
  const repondreAvis = async (ctx: Context, avis: { id: number; chatSealed: string | null }, texte: string) => {
    if (!avis.chatSealed) return void (await ctx.reply("Impossible de répondre à cet avis (personne injoignable)."));
    try {
      const chatId = openChatId(avis.chatSealed, deps.pseudonymSecret);
      const sent = await ctx.api.sendMessage(chatId, MESSAGES.reponseEquipe(texte.slice(0, 3000)), {
        parse_mode: "HTML",
        reply_markup: { force_reply: true, input_field_placeholder: "Ta réponse…" },
      });
      // Sa réponse à ce message sera un nouvel avis, transmis à l'équipe : l'échange continue.
      await deps.store.addAvisPrompt(pseudonymize(chatId, deps.pseudonymSecret), sent.message_id);
      log?.info("réponse à un avis", { avis: avis.id, par: pseudoOf(ctx, deps) });
      await ctx.reply(`Réponse envoyée (avis n° ${avis.id}).`);
    } catch (e) {
      log?.error("réponse à un avis impossible", { avis: avis.id, erreur: e instanceof Error ? e.message : String(e) });
      await ctx.reply("Réponse non envoyée : la personne a peut-être bloqué le bot.");
    }
  };

  // --- Jetons de l'extension de capture (équipe seulement) -------------------------------
  bot.command("jeton", async (ctx) => {
    const pseudo = pseudoOf(ctx, deps);
    if (!pseudo || !deps.team?.has(ctx.from!.id) || !deps.argu) return void (await ctx.reply(ADMIN_MESSAGES.reserve));
    try {
      if (/^r[ée]voquer$/i.test(String(ctx.match ?? "").trim())) {
        const n = await deps.argu.revoquerJetons(pseudo);
        log?.info("jeton révoqué", { pseudo, n });
        return void (await ctx.reply(JETON_MESSAGES.revoque(n)));
      }
      const jeton = await deps.argu.creerJeton(pseudo);
      // Jamais le jeton dans le journal : seulement qu'un jeton a été créé, et pour qui.
      log?.info("jeton créé", { pseudo });
      await ctx.reply(JETON_MESSAGES.nouveau(jeton), { parse_mode: "HTML" });
    } catch (e) {
      await adminError(ctx, e);
    }
  });

  // « /repondre 12 texte » : pour répondre sans passer par la notification.
  bot.command("repondre", async (ctx) => {
    if (!ctx.from || !deps.team?.has(ctx.from.id)) return void (await ctx.reply(ADMIN_MESSAGES.reserve));
    const m = /^(\d+)\s+([\s\S]+)$/.exec(String(ctx.match ?? "").trim());
    if (!m) return void (await ctx.reply("Usage : <code>/repondre numéro texte</code>", { parse_mode: "HTML" }));
    const avis = await deps.store.avisById(Number(m[1]));
    if (!avis) return void (await ctx.reply("Avis introuvable : il a expiré ou la personne a effacé ses échanges."));
    await repondreAvis(ctx, avis, m[2]!.trim());
  });

  bot.command("avis", async (ctx) => {
    const pseudo = pseudoOf(ctx, deps);
    if (!pseudo) return;
    const texte = String(ctx.match ?? "").trim();
    if (texte) return enregistrerAvis(ctx, pseudo, texte);
    const prompt = await ctx.reply(MESSAGES.demandeAvis, {
      reply_markup: { force_reply: true, input_field_placeholder: "Ton avis sur le bot…" },
    });
    await deps.store.addAvisPrompt(pseudo, prompt.message_id);
  });

  bot.command("oublier", async (ctx) => {
    const pseudo = pseudoOf(ctx, deps);
    if (!pseudo) return;
    // Les traces d'abord : leurs identifiants sont dans les conversations qu'on va effacer.
    await deps.feedback?.forgetTraces(await deps.store.traceIds(pseudo));
    await deps.store.forget(pseudo);
    await ctx.reply(MESSAGES.oublie);
  });

  bot.on("message:text", async (ctx) => {
    const question = ctx.message.text.trim();
    if (question.startsWith("/")) return; // commande inconnue (ou de l'étape 4)
    const pseudo = pseudoOf(ctx, deps);
    if (!pseudo) return;

    // Réponse à « qu'est-ce qui n'allait pas ? » : c'est un commentaire, pas une question.
    const repliedTo = ctx.message.reply_to_message?.message_id;
    // Un membre de l'équipe qui répond à la notification d'un avis.
    if (repliedTo && deps.team?.has(ctx.from.id)) {
      const avis = await deps.store.avisOfNotif(ctx.from.id, repliedTo);
      if (avis) return repondreAvis(ctx, avis, question);
      if (ctx.message.reply_to_message?.text?.startsWith("💬 Avis n°")) {
        return void (await ctx.reply("Avis introuvable : il a expiré ou la personne a effacé ses échanges."));
      }
    }
    if (repliedTo && (await deps.store.takeAvisPrompt(pseudo, repliedTo))) {
      return enregistrerAvis(ctx, pseudo, question);
    }
    if (repliedTo && deps.feedback) {
      const target = await deps.store.takeFeedbackPrompt(pseudo, repliedTo);
      if (target) {
        await deps.feedback.comment({ ...target, pseudo, comment: question.slice(0, MAX_COMMENT) });
        log?.info("commentaire reçu", { pseudo, traceId: target.traceId });
        return void (await ctx.reply(MESSAGES.commentaireNote));
      }
    }

    // « 2 » : la deuxième question proposée sous la dernière réponse.
    const choix = parseChoix(question);
    if (choix !== undefined) {
      const suite = (await deps.store.lastSuites(pseudo))[choix - 1];
      if (suite) return traiterQuestion(ctx, pseudo, suite, true);
    }
    await traiterQuestion(ctx, pseudo, question);
  });

  /** Une question → réponse vérifiée, avec ses boutons. `rappel` : la question n'a pas été tapée, on la rappelle. */
  const traiterQuestion = async (ctx: Context, pseudo: string, question: string, rappel = false) => {
    if (question.length > MAX_QUESTION) return void (await ctx.reply(MESSAGES.tropLong));

    const hit = await deps.store.hit(pseudo, deps.ratePerHour);
    if (!hit.allowed) return void (await ctx.reply(MESSAGES.limite(deps.ratePerHour, hit.resetAt)));

    await ctx.replyWithChatAction("typing").catch(() => {});
    const started = Date.now();
    try {
      const historique = await deps.store.history(pseudo);
      const { reponse, usage, traceId, spanId } = await deps.repondre(question, { historique });
      // Sans trace, pas de boutons : les suites restent accessibles en envoyant leur numéro.
      const suites = reponse.statut === "repondu" ? (reponse.suites ?? []) : [];
      const keyboard = traceId ? answerKeyboard(traceId, { votes: !!deps.feedback, suites }) : undefined;
      await ctx.reply(formatAnswer({ ...reponse, suites }, rappel ? question : undefined), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
      await deps.store.append(pseudo, question, answerForMemory(reponse), traceId, spanId, suites);
      // Ni question, ni réponse, ni identifiant dans les journaux.
      log?.info("question traitée", {
        pseudo,
        statut: reponse.statut,
        // Une suite choisie qui finit « introuvable » : le seuil SUITES_MIN_SCORE est trop bas.
        origine: rappel ? "suite" : "question",
        suitesProposees: suites.length,
        ...reponse.controle,
        ...usage,
        ms: Date.now() - started,
      });
    } catch (e) {
      log?.error("échec de la réponse", { pseudo, erreur: e instanceof Error ? e.message : String(e) });
      await ctx.reply(MESSAGES.erreur).catch(() => {});
    }
  };

  // Bouton « 1 », « 2 », « 3 » sous une réponse : on pose la question proposée.
  bot.callbackQuery(/^sx:([1-9]):([0-9a-f]{16,64})$/, async (ctx) => {
    const pseudo = pseudoOf(ctx, deps);
    const [, n, traceId] = ctx.match as RegExpMatchArray;
    // Le bouton vient du client : la suite est relue en base, pour cette personne et cette réponse.
    const suite = pseudo ? (await deps.store.suitesOf(pseudo, traceId!))[Number(n) - 1] : undefined;
    if (!pseudo || !suite) return void (await ctx.answerCallbackQuery({ text: MESSAGES.suiteExpiree }));
    await ctx.answerCallbackQuery();
    await traiterQuestion(ctx, pseudo, suite, true);
  });

  bot.callbackQuery(/^fb:(up|down):([0-9a-f]{16,64})$/, async (ctx) => {
    const pseudo = pseudoOf(ctx, deps);
    const [, sens, traceId] = ctx.match as RegExpMatchArray;
    // Le bouton vient du client : on vérifie que cette réponse a bien été donnée à cette personne.
    const answer = pseudo && deps.feedback ? await deps.store.answerOf(pseudo, traceId!) : undefined;
    if (!pseudo || !deps.feedback || !answer) {
      return void (await ctx.answerCallbackQuery({ text: MESSAGES.voteExpire }));
    }
    const value = sens === "up" ? 1 : -1;
    try {
      await deps.feedback.vote({ traceId: traceId!, spanId: answer.spanId, pseudo, value });
    } catch (e) {
      log?.error("échec du vote", { pseudo, erreur: e instanceof Error ? e.message : String(e) });
      return void (await ctx.answerCallbackQuery({ text: MESSAGES.erreur }));
    }
    log?.info("vote reçu", { pseudo, traceId, value });
    await ctx.answerCallbackQuery({ text: MESSAGES.merci });
    // Un seul vote par réponse : les boutons 👍/👎 disparaissent, ceux des suites restent.
    const suites = await deps.store.suitesOf(pseudo, traceId!);
    const keep = answerKeyboard(traceId!, { votes: false, suites }) ?? new InlineKeyboard();
    await ctx.editMessageReplyMarkup({ reply_markup: keep }).catch(() => {});
    if (value === -1) {
      const prompt = await ctx.reply(MESSAGES.demandeCommentaire, {
        reply_markup: { force_reply: true, input_field_placeholder: "Ce qui n'allait pas…" },
      });
      await deps.store.addFeedbackPrompt(pseudo, prompt.message_id, traceId!);
    }
  });

  bot.on("message", (ctx) => ctx.reply(MESSAGES.texteSeulement));

  bot.catch((err) => log?.error("erreur grammY", { erreur: err.message }));
  return bot;
}

function pseudoOf(ctx: Context, deps: BotDeps): string | undefined {
  return ctx.from ? pseudonymize(ctx.from.id, deps.pseudonymSecret) : undefined;
}
