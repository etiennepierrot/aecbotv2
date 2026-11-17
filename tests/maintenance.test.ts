import { describe, expect, it } from "vitest";
import { ALERTE_BOUTON, MESSAGE_MAINTENANCE, reponseMaintenance } from "../maintenance/reponse.js";
import worker from "../maintenance/worker.js";

const SECRET = "s3cret";
const prive = { update_id: 1, message: { message_id: 3, chat: { id: 42, type: "private" }, text: "retraite ?" } };

describe("reponseMaintenance", () => {
  it("répond par un sendMessage au chat privé", () => {
    expect(reponseMaintenance(prive, SECRET, SECRET)).toEqual({
      status: 200,
      body: { method: "sendMessage", chat_id: 42, text: MESSAGE_MAINTENANCE },
    });
  });

  it("refuse sans le bon secret, ou si aucun secret n'est configuré", () => {
    expect(reponseMaintenance(prive, null, SECRET)).toEqual({ status: 401, body: null });
    expect(reponseMaintenance(prive, "faux", SECRET)).toEqual({ status: 401, body: null });
    expect(reponseMaintenance(prive, "", "")).toEqual({ status: 401, body: null });
  });

  it("affiche une alerte sur un bouton", () => {
    const update = { update_id: 2, callback_query: { id: "cb1", data: "fb:up" } };
    expect(reponseMaintenance(update, SECRET, SECRET).body).toEqual({
      method: "answerCallbackQuery",
      callback_query_id: "cb1",
      text: ALERTE_BOUTON,
      show_alert: true,
    });
  });

  it("se tait dans les groupes et sur les mises à jour inconnues", () => {
    const groupe = { message: { chat: { id: -100, type: "supergroup" } } };
    expect(reponseMaintenance(groupe, SECRET, SECRET)).toEqual({ status: 200, body: null });
    expect(reponseMaintenance({ edited_message: {} }, SECRET, SECRET)).toEqual({ status: 200, body: null });
    expect(reponseMaintenance(null, SECRET, SECRET)).toEqual({ status: 200, body: null });
  });
});

describe("worker", () => {
  const env = { TELEGRAM_WEBHOOK_SECRET: SECRET };
  const post = (body: string, secret?: string) =>
    new Request("https://x.workers.dev/", {
      method: "POST",
      body,
      headers: secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {},
    });

  it("renvoie l'appel de méthode en JSON", async () => {
    const res = await worker.fetch(post(JSON.stringify(prive), SECRET), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toMatchObject({ method: "sendMessage", chat_id: 42 });
  });

  it("rejette une requête sans secret et tolère un corps invalide", async () => {
    expect((await worker.fetch(post(JSON.stringify(prive)), env)).status).toBe(401);
    const res = await worker.fetch(post("pas du json", SECRET), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});
