import { describe, expect, it } from "vitest";
import { empreinte, enregistrerCapture, normaliserUrl } from "../src/argu/capture.js";
import { creerJeton, empreinteJeton, verifierJeton } from "../src/argu/jetons.js";
import type { NouvelleCapture } from "../src/argu/store.js";

/** Stockage en mémoire : même contrat de déduplication que la table (empreinte unique). */
function memoire() {
  const lignes = new Map<string, NouvelleCapture & { id: string }>();
  return {
    lignes,
    async insererCapture(c: NouvelleCapture) {
      const existante = [...lignes.values()].find((l) => l.empreinte === c.empreinte);
      if (existante) return { id: existante.id, doublon: true };
      const id = `c${lignes.size + 1}`;
      lignes.set(id, { ...c, id });
      return { id, doublon: false };
    },
  };
}

const origine = { capturePar: "u_test", canal: "extension" as const };
const post = {
  source_type: "x",
  url: "https://twitter.com/compte/status/123?s=20&t=abc&utm_source=x",
  texte: "  Texte complet\n du post  ",
  auteur: { nom: "Nom affiché", identifiant: "@compte" },
  publie_le: "2026-11-16T18:42:00Z",
  note: "Entendu aussi au marché samedi",
};

describe("normaliserUrl", () => {
  it("donne la même URL pour un post partagé de plusieurs façons", () => {
    const canon = "https://x.com/compte/status/123";
    expect(normaliserUrl("https://twitter.com/compte/status/123?s=20&t=abc")).toBe(canon);
    expect(normaliserUrl("https://mobile.twitter.com/compte/status/123/")).toBe(canon);
    expect(normaliserUrl("https://www.x.com/compte/status/123#reply")).toBe(canon);
  });

  it("garde l'horodatage YouTube, retire les paramètres de suivi", () => {
    expect(normaliserUrl("https://www.youtube.com/watch?v=abc&t=95&si=xyz&utm_medium=share")).toBe(
      "https://youtube.com/watch?t=95&v=abc",
    );
    expect(normaliserUrl("https://site.fr/article?id=4&fbclid=zz")).toBe("https://site.fr/article?id=4");
  });
});

describe("empreinte", () => {
  it("ne dépend ni des espaces ni de la forme Unicode du texte", () => {
    const u = "https://x.com/a/status/1";
    expect(empreinte(u, "Le  coût\ndu plein")).toBe(empreinte(u, "Le coût du plein "));
    expect(empreinte(u, "été")).toBe(empreinte(u, "été"));
    expect(empreinte(u, "un texte")).not.toBe(empreinte("https://x.com/a/status/2", "un texte"));
  });
});

describe("enregistrerCapture", () => {
  it("enregistre la capture, URL normalisée, et lance la consolidation une seule fois", async () => {
    const store = memoire();
    const lancees: string[] = [];
    const deps = { store, lancerConsolidation: async (id: string) => void lancees.push(id) };
    const r = await enregistrerCapture(post, origine, deps);
    expect(r).toEqual({ ok: true, id: "c1", doublon: false });
    expect(store.lignes.get("c1")).toMatchObject({
      sourceType: "x", url: "https://x.com/compte/status/123", texte: "Texte complet\n du post",
      auteurNom: "Nom affiché", auteurIdentifiant: "@compte", capturePar: "u_test", canal: "extension",
    });
    // Même post, partagé autrement et avec d'autres espaces : doublon, rien n'est relancé.
    const bis = await enregistrerCapture({ ...post, url: "https://x.com/compte/status/123", texte: "Texte complet du post" }, origine, deps);
    expect(bis).toEqual({ ok: true, id: "c1", doublon: true });
    expect(lancees).toEqual(["c1"]);
  });

  it("une consolidation en échec n'empêche pas d'enregistrer la capture", async () => {
    const erreurs: string[] = [];
    const r = await enregistrerCapture(post, origine, {
      store: memoire(),
      lancerConsolidation: async () => { throw new Error("modèle indisponible"); },
      logger: { error: (msg) => void erreurs.push(msg) },
    });
    expect(r.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 0));
    expect(erreurs).toEqual(["consolidation non lancée"]);
  });

  it.each([
    [{ ...post, source_type: "facebook" }, "source_type"],
    [{ ...post, url: undefined }, "url"],
    [{ ...post, url: "http://x.com/a/status/1" }, "url"],
    [{ ...post, url: "/relative" }, "url"],
    [{ ...post, texte: "   " }, "texte"],
    [{ ...post, publie_le: "hier" }, "publie_le"],
    [{ ...post, note: "n".repeat(501) }, "note"],
    [null, null],
  ])("refuse un corps invalide en nommant le champ (%#)", async (body, champ) => {
    const r = await enregistrerCapture(body, origine, { store: memoire() });
    expect(r).toMatchObject({ ok: false, code: 422, champ });
  });

  it("413 pour un texte trop long ; un texte Telegram n'a pas besoin d'URL", async () => {
    expect(await enregistrerCapture({ ...post, texte: "a".repeat(50_001) }, origine, { store: memoire() })).toMatchObject({
      ok: false, code: 413, champ: "texte",
    });
    const tg = await enregistrerCapture({ source_type: "telegram_texte", texte: "Entendu au marché" }, origine, { store: memoire() });
    expect(tg).toMatchObject({ ok: true, doublon: false });
  });
});

describe("jetons", () => {
  it("ne stocke que l'empreinte, et ne reconnaît que le jeton exact en Bearer", async () => {
    const stockees = new Map<string, string>();
    const store = {
      async remplacerJeton(pseudo: string, e: string) { stockees.set(e, pseudo); },
      async jetonActif(e: string) { return stockees.get(e); },
    };
    const jeton = await creerJeton(store, "u_membre");
    expect(jeton).toMatch(/^aec_[A-Za-z0-9_-]{43}$/);
    expect([...stockees.keys()]).toEqual([empreinteJeton(jeton)]);
    expect(JSON.stringify([...stockees])).not.toContain(jeton);

    expect(await verifierJeton(store, `Bearer ${jeton}`)).toBe("u_membre");
    expect(await verifierJeton(store, `bearer  ${jeton} `)).toBe("u_membre");
    expect(await verifierJeton(store, jeton)).toBeUndefined();
    expect(await verifierJeton(store, `Bearer ${jeton}x`)).toBeUndefined();
    expect(await verifierJeton(store, undefined)).toBeUndefined();
  });
});
