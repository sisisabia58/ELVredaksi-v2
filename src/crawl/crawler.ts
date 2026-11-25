import { assertPublicFetchUrl } from "../rss/fetch-guard";
import { canonicalUrl } from "./canonical";

export type CrawledArticle = {
  url: string;
  title: string;
  author: string | null;
  text: string;
  publishedAt: Date | null;
};

export interface Crawler {
  listing(url: string): Promise<string[]>;
  article(url: string): Promise<CrawledArticle>;
}

const NON_ARTICLE_PATH =
  /^\/(tag|tags|author|authors|category|categories|page|penulis|kategori|topik|indeks|about|tentang|contact|kontak|login|masuk|subscribe|search|cari|privacy)(\/|$)/i;

export function articleLinksFromListing(listingUrl: string, links: string[], max: number): string[] {
  let listing: URL;
  try {
    listing = new URL(listingUrl);
  } catch {
    return [];
  }
  const listingCanonical = canonicalUrl(listing.href);
  const listingPath = listing.pathname.replace(/\/+$/, "") || "/";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of links) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    if (parsed.host.toLowerCase() !== listing.host.toLowerCase()) continue;
    if (NON_ARTICLE_PATH.test(parsed.pathname)) continue;
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    // The site root, the listing itself (even with a query), and any ancestor of it are navigation.
    if (path === "/" || path === listingPath || listingPath.startsWith(`${path}/`)) continue;
    const canonical = canonicalUrl(parsed.href);
    if (canonical === listingCanonical || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
    if (out.length >= max) break;
  }
  return out;
}

export function titleFromMarkdown(markdown: string, fallbackUrl: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  try {
    const slug = new URL(fallbackUrl).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(slug).replace(/-/g, " ").trim() || fallbackUrl;
  } catch {
    return fallbackUrl;
  }
}

export class FakeCrawler implements Crawler {
  constructor(
    private readonly data: {
      listings?: Record<string, string[]>;
      articles?: Record<string, CrawledArticle>;
      failOn?: string[];
    } = {},
  ) {}

  readonly articleCalls: string[] = [];

  async listing(url: string): Promise<string[]> {
    if (this.data.failOn?.includes(url)) throw new Error(`crawl gagal: ${url}`);
    return this.data.listings?.[url] ?? [];
  }

  async article(url: string): Promise<CrawledArticle> {
    this.articleCalls.push(url);
    if (this.data.failOn?.includes(url)) throw new Error(`crawl gagal: ${url}`);
    const found = this.data.articles?.[url];
    if (!found) throw new Error(`artikel tidak ditemukan: ${url}`);
    return found;
  }
}

const TAVILY_BASE = "https://api.tavily.com";
const TAVILY_TIMEOUT_MS = 30_000;

export class TavilyCrawler implements Crawler {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly guard: (url: string) => Promise<void> = (url) => assertPublicFetchUrl(url),
  ) {}

  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${TAVILY_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Tavily ${path} gagal (${response.status})`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async listing(url: string): Promise<string[]> {
    await this.guard(url);
    const body = await this.post("/map", { url });
    const results = body.results;
    return Array.isArray(results) ? results.filter((item): item is string => typeof item === "string") : [];
  }

  async article(url: string): Promise<CrawledArticle> {
    await this.guard(url);
    const body = await this.post("/extract", { urls: [url], format: "markdown" });
    const results = Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : [];
    const first = results[0];
    const raw = typeof first?.raw_content === "string" ? first.raw_content : "";
    if (!first || !raw) {
      throw new Error(`Tavily tidak mengembalikan isi untuk ${url}`);
    }
    return { url, title: titleFromMarkdown(raw, url), author: null, text: raw, publishedAt: null };
  }
}

export function createCrawler(env: Record<string, string | undefined> = process.env): Crawler {
  const provider = env.CRAWLER_PROVIDER?.trim() || "fake";
  if (provider === "fake") return new FakeCrawler();
  if (provider === "tavily") {
    const key = env.TAVILY_API_KEY?.trim();
    if (!key) throw new Error("TAVILY_API_KEY is required");
    return new TavilyCrawler(key);
  }
  throw new Error("unknown CRAWLER_PROVIDER");
}

export const DEFAULT_CRAWL_MAX_ARTICLES_PER_SCAN = 5;

/** CRAWL_MAX_ARTICLES_PER_SCAN: unset or invalid = 5 articles per crawl source per scan. */
export function crawlMaxArticlesPerScan(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CRAWL_MAX_ARTICLES_PER_SCAN?.trim();
  if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1) return DEFAULT_CRAWL_MAX_ARTICLES_PER_SCAN;
  return Number(raw);
}
