/** What kind of evidence a research item represents. */
export type ResearchSourceKind = "paper" | "news" | "article" | "comment";

/** Geographic perspective represented by a source. */
export type ResearchRegion = "domestic" | "international" | "global";

/** Category of a news/RSS source, used to pick feeds per domain. */
export type NewsSourceType = "international" | "technology" | "finance" | "chinese";

/** A configured news/RSS feed. */
export interface NewsSource {
  id: string;
  name: string;
  type: NewsSourceType;
  /** Editorial region for a fixed feed; aggregators use `global` until each publisher is inferred. */
  region: ResearchRegion;
  language: "zh" | "en";
  url: string;
  enabled: boolean;
}

/** A normalized research result from any source (paper or news). */
export interface ResearchItem {
  id: string;
  sourceKind: ResearchSourceKind;
  sourceName: string;
  sourceId: string;
  /** Used to keep domestic and international perspectives represented. */
  region: ResearchRegion;
  title: string;
  summary: string;
  /** A short verbatim passage that may be quoted sparingly with attribution. */
  excerpt?: string;
  /** Bounded source-page text used only by the evidence extractor, never sent to clients. */
  content?: string;
  url: string;
  imageUrl?: string;
  publishedAt: string;
  authors: string[];
  query: string;
}

/** The full result of one research collection: items plus any source failures. */
export interface ResearchBundle {
  query: string;
  generatedAt: string;
  items: ResearchItem[];
  unavailableSources: string[];
  coverage: {
    domestic: number;
    international: number;
    global: number;
    uniqueSources: number;
  };
}
