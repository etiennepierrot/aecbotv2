import { describe, expect, it } from "vitest";
import { anonymiserQuestion } from "../src/telegram/anonymiser.js";

describe("anonymiserQuestion", () => {
  it("masque courriels, téléphones, liens, comptes, IBAN et longs numéros", () => {
    expect(anonymiserQuestion("Écris à jean.dupont@gmail.com ou au 06 12 34 56 78")).toBe("Écris à [courriel] ou au [téléphone]");
    expect(anonymiserQuestion("+33 6 12 34 56 78 et 0612345678")).toBe("[téléphone] et [téléphone]");
    expect(anonymiserQuestion("voir https://x.com/a?b=1 et @jlm_2027")).toBe("voir [lien] et [compte]");
    expect(anonymiserQuestion("FR76 3000 6000 0112 3456 7890 189")).toBe("[iban]");
    expect(anonymiserQuestion("n° CAF 1234567, sécu 1 85 05 78 006 084 36")).toBe("n° CAF [numéro], sécu [numéro]");
  });

  it("garde montants, années et âges", () => {
    expect(anonymiserQuestion("  SMIC à 1600 euros en 2027,\n retraite à 60 ans ? ")).toBe("SMIC à 1600 euros en 2027, retraite à 60 ans ?");
  });
});
