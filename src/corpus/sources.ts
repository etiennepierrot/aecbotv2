import type { SourceItem } from "./types.js";

export interface ItemSource {
  listItems(): Promise<SourceItem[]>;
}

/**
 * Documents hors du WordPress actuel, déclarés à la main. Vide depuis que seul le livre 2026
 * fait foi pour le programme : la version abrégée 2022 (aec2022:programme-abrege) en a été
 * retirée, et le scan suivant la sort de l'index. Les livrets et plans 2022, eux, restent.
 */
export const EDITION_2022: SourceItem[] = [];

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
