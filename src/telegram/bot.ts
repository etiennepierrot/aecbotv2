import { Bot, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { repondre as repondreFn } from "../aec/repondre.js";
import { answerForMemory, DISCLAIMER, escapeHtml, formatAnswer } from "./format.js";
import { pseudonymize } from "./privacy.js";
import type { BotStore } from "./store.js";

export interface BotDeps {
  repondre: typeof repondreFn;
  store: BotStore;
  pseudonymSecret: string;
  ratePerHour: number;
  memoryDays: number;
  logger?: { info: (msg: string, meta?: object) => void; error: (msg: string, meta?: object) => void };
}

const MAX_QUESTION = 500;

export const MESSAGES = {
  bienvenue: (memoryDays: number, rate: number) =>
    [
      "Bonjour ! Je réponds à tes questions sur le programme <b>L'Avenir en commun</b>, ses livrets et ses plans.",
      "Je cherche dans les documents publiés et je cite chaque source avec sa page. Si je ne trouve pas, je te le dis plutôt que d'inventer.",
      "Exemple : <i>Qu'est-ce que le programme dit sur la retraite ?</i>",
      `Tes questions sont gardées ${memoryDays} jours, sous un pseudonyme, pour comprendre les questions de suite. /oublier les efface. Limite : ${rate} questions par heure.`,
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
};

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

  bot.command("oublier", async (ctx) => {
    const pseudo = pseudoOf(ctx, deps);
    if (!pseudo) return;
    await deps.store.forget(pseudo);
    await ctx.reply(MESSAGES.oublie);
  });

  bot.on("message:text", async (ctx) => {
    const question = ctx.message.text.trim();
    if (question.startsWith("/")) return; // commande inconnue (ou de l'étape 4)
    const pseudo = pseudoOf(ctx, deps);
    if (!pseudo) return;

    if (question.length > MAX_QUESTION) return void (await ctx.reply(MESSAGES.tropLong));

    const hit = await deps.store.hit(pseudo, deps.ratePerHour);
    if (!hit.allowed) return void (await ctx.reply(MESSAGES.limite(deps.ratePerHour, hit.resetAt)));

    await ctx.replyWithChatAction("typing").catch(() => {});
    const started = Date.now();
    try {
      const historique = await deps.store.history(pseudo);
      const { reponse, usage } = await deps.repondre(question, { historique });
      await ctx.reply(formatAnswer(reponse), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      await deps.store.append(pseudo, question, answerForMemory(reponse));
      // Ni question, ni réponse, ni identifiant dans les journaux.
      log?.info("question traitée", {
        pseudo,
        statut: reponse.statut,
        ...reponse.controle,
        ...usage,
        ms: Date.now() - started,
      });
    } catch (e) {
      log?.error("échec de la réponse", { pseudo, erreur: e instanceof Error ? e.message : String(e) });
      await ctx.reply(MESSAGES.erreur).catch(() => {});
    }
  });

  bot.on("message", (ctx) => ctx.reply(MESSAGES.texteSeulement));

  bot.catch((err) => log?.error("erreur grammY", { erreur: err.message }));
  return bot;
}

function pseudoOf(ctx: Context, deps: BotDeps): string | undefined {
  return ctx.from ? pseudonymize(ctx.from.id, deps.pseudonymSecret) : undefined;
}
