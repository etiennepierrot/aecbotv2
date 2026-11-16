import { describe, expect, it } from "vitest";
import { CompositeSource, EDITION_2022, StaticSource } from "../src/corpus/sources.js";

describe("sources", () => {
  it("assemble les documents WordPress et les sources fixes", async () => {
    const wp = { listItems: async () => [{ id: "wp:media:1" } as never], download: async () => new Uint8Array([1]) };
    const fixe = new StaticSource([{ id: "fixe:1" } as never]);
    const all = await new CompositeSource([wp, fixe], wp).listItems();
    expect(all.map((i) => i.id)).toEqual(["wp:media:1", "fixe:1"]);
  });

  it("n'interroge plus la version abrégée 2022 du programme : seul le livre 2026 fait foi", () => {
    expect(EDITION_2022.some((i) => i.forced?.category === "programme")).toBe(false);
  });
});
