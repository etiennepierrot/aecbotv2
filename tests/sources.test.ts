import { describe, expect, it } from "vitest";
import { CompositeSource, EDITION_2022, StaticSource } from "../src/corpus/sources.js";

describe("sources", () => {
  it("ajoute l'édition 2022 aux documents WordPress", async () => {
    const wp = { listItems: async () => [{ id: "wp:media:1" } as never], download: async () => new Uint8Array([1]) };
    const all = await new CompositeSource([wp, new StaticSource(EDITION_2022)], wp).listItems();
    expect(all.map((i) => i.id)).toEqual(["wp:media:1", "aec2022:programme-abrege"]);
    expect(EDITION_2022[0]!.url).toMatch(/^https:\/\/melenchon2022\.fr\/.+\.pdf$/);
  });
});
