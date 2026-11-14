import type { SourceItem } from "./types.js";

export interface ItemSource {
  listItems(): Promise<SourceItem[]>;
}

/**
 * L'Avenir en commun, édition 2022 (campagne de l'Union populaire), hors du WordPress
 * actuel. Les livrets et plans 2022 y sont déjà, re-téléversés en 2024 : seul le
 * programme manque. La version intégrale n'est pas publiée en PDF ; la version
 * abrégée officielle sert donc de référence 2022.
 */
export const EDITION_2022: SourceItem[] = [
  {
    id: "aec2022:programme-abrege",
    origin: "wordpress",
    kind: "pdf",
    title: "L'Avenir en commun 2022, version abrégée",
    url: "https://melenchon2022.fr/wp-content/uploads/2022/04/LAvenir-en-commun-le-programme-en-version-abregee.pdf",
    modified: "2022-04-01T00:00:00.000Z",
    forced: { category: "programme", corpus: "aec2022" },
  },
];

/** Liste fixe de documents : jamais « disparus », jamais retéléchargés tant que la date ne change pas. */
export class StaticSource implements ItemSource {
  constructor(private readonly items: SourceItem[]) {}
  async listItems() {
    return this.items;
  }
}

/** Plusieurs sources vues comme une seule par le workflow d'ingestion. */
export class CompositeSource {
  constructor(
    private readonly sources: ItemSource[],
    private readonly downloader: { download(url: string): Promise<Uint8Array> },
  ) {}

  async listItems(): Promise<SourceItem[]> {
    const lists = await Promise.all(this.sources.map((s) => s.listItems()));
    return lists.flat();
  }

  download(url: string): Promise<Uint8Array> {
    return this.downloader.download(url);
  }
}
