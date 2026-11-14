import { describe, expect, it } from "vitest";
import { WordPressSource } from "../src/corpus/wordpress.js";

function fakeWp(routes: Record<string, unknown[][]>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.replace("/wp-json/wp/v2/", "");
    const pages = routes[endpoint] ?? [[]];
    const page = Number(url.searchParams.get("page"));
    if (page > pages.length) return new Response("[]", { status: 400 });
    return new Response(JSON.stringify(pages[page - 1]), {
      headers: { "x-wp-totalpages": String(pages.length), "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("WordPressSource", () => {
  it("liste les PDF sur plusieurs pages d'API et les seules pages sous /programme/", async () => {
    const wp = new WordPressSource("https://melenchon2027.fr", fakeWp({
      media: [
        [{ id: 2, source_url: "https://melenchon2027.fr/wp-content/uploads/2024/02/Livret_UP_13_SANTE_web-ok.pdf", modified_gmt: "2024-02-02T10:00:00", title: { rendered: "Livret_UP_13_SANTE_web-ok" } }],
        [{ id: 1, source_url: "https://melenchon2027.fr/wp-content/uploads/2025/02/A5-PROGRAMME-SITE.pdf", modified_gmt: "2025-02-18T10:00:00", title: { rendered: "PROGRAMME SITE 2025" } }],
      ],
      pages: [[
        { id: 10, link: "https://melenchon2027.fr/programme/retraites/", modified_gmt: "2026-03-01T08:00:00", title: { rendered: "Retraites &#8211; 60 ans" }, content: { rendered: "<p>Texte</p>" } },
        { id: 11, link: "https://melenchon2027.fr/agenda/", modified_gmt: "2026-03-01T08:00:00", title: { rendered: "Agenda" }, content: { rendered: "" } },
      ]],
      posts: [[]],
    }));

    const items = await wp.listItems();
    expect(items.map((i) => i.id).sort()).toEqual(["wp:media:1", "wp:media:2", "wp:page:10"]);
    const page = items.find((i) => i.id === "wp:page:10");
    expect(page).toMatchObject({ kind: "html", title: "Retraites – 60 ans", modified: "2026-03-01T08:00:00.000Z", inlineContent: "<p>Texte</p>" });
  });

  it("échoue clairement si l'API répond en erreur", async () => {
    const wp = new WordPressSource("https://x", (async () => new Response("", { status: 503 })) as typeof fetch);
    await expect(wp.listItems()).rejects.toThrow(/HTTP 503/);
  });
});
