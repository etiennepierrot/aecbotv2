import type { ReferencedPassage, RetrievedPassage } from "./types.js";

/** Clé du collecteur dans le RequestContext d'un appel à l'agent. */
export const COLLECTOR_KEY = "aec:passages";

/**
 * Garde, pour une question, tous les passages que l'outil de recherche a
 * réellement renvoyés à l'agent. Chacun reçoit une référence courte (P1, P2…),
 * stable sur plusieurs recherches. Une citation qui n'est pas ici est inventée.
 */
export class PassageCollector {
  private readonly byId = new Map<string, ReferencedPassage>();
  private readonly byRef = new Map<string, ReferencedPassage>();

  add(passages: RetrievedPassage[]): ReferencedPassage[] {
    return passages.map((p) => {
      const known = this.byId.get(p.id);
      if (known) return known;
      const ref = `P${this.byId.size + 1}`;
      const withRef = { ...p, ref };
      this.byId.set(p.id, withRef);
      this.byRef.set(ref, withRef);
      return withRef;
    });
  }

  get(ref: string): ReferencedPassage | undefined {
    return this.byRef.get(ref.toUpperCase());
  }

  all(): ReferencedPassage[] {
    return [...this.byRef.values()];
  }

  get size(): number {
    return this.byRef.size;
  }
}
