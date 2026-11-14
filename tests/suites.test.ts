/** Filtrage des suites : on ne propose que ce que le corpus sait servir. */
import { beforeAll, describe, expect, it } from "vitest";

const SCORES: Record<string, number> = {
  "Comment la retraite serait-elle financée ?": 0.86,
  "Que pense Mélenchon du football ?": 0.62,
  "Et les carrières longues ?": 0.8,
};
const calls = { embed: 0, filters: [] as unknown[] };
let panne = false;

let filtrerSuites: typeof import("../src/aec/suites.js").filtrerSuites;

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgresql://inutilise@localhost/inutilise";
  const deps = await import("../src/corpus/deps.js");
  const questions = Object.keys(SCORES);
  deps.setRetrievalDeps({
    embedder: {
      dimension: 1,
      embed: async (t: string[]) => {
        calls.embed++;
        if (panne) throw new Error("API indisponible");
        return t.map((q) => [questions.indexOf(q)]);
      },
    },
    vector: {
      query: (async (args: { queryVector: number[]; filter: unknown }) => {
        calls.filters.push(args.filter);
        return [{ id: "x", score: SCORES[questions[args.queryVector[0]!]!]!, metadata: {} }];
      }) as never,
    },
  });
  ({ filtrerSuites } = await import("../src/aec/suites.js"));
});

describe("filtrerSuites", () => {
  it("garde les suites dont un passage est assez proche, en un seul appel d'embeddings", async () => {
    calls.embed = 0;
    calls.filters.length = 0;
    const r = await filtrerSuites(Object.keys(SCORES), 0.8);
    expect(r).toEqual({ gardees: ["Comment la retraite serait-elle financée ?", "Et les carrières longues ?"], retirees: 1 });
    expect(calls.embed).toBe(1);
    expect(calls.filters[0]).toEqual({ corpus: { $in: ["aec2027", "aec2022"] } });
  });

  it("en cas de panne, ne propose rien", async () => {
    panne = true;
    expect(await filtrerSuites(["Et les carrières longues ?"], 0.5)).toEqual({ gardees: [], retirees: 1 });
    panne = false;
  });

  it("aucune suite : aucun appel", async () => {
    calls.embed = 0;
    expect(await filtrerSuites([], 0.8)).toEqual({ gardees: [], retirees: 0 });
    expect(calls.embed).toBe(0);
  });
});
