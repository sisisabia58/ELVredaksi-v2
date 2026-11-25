import { describe, expect, it, vi } from "vitest";
import { canonicalUrl } from "../src/crawl/canonical";
import {
  FakeCrawler,
  TavilyCrawler,
  articleLinksFromListing,
  createCrawler,
  titleFromMarkdown,
} from "../src/crawl/crawler";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("canonicalUrl", () => {
  it("drops tracking params, fragment and trailing slash, lowercases host", () => {
    expect(canonicalUrl("https://Blog.Example/Post/?utm_source=x&ref=y#top")).toBe("https://blog.example/Post");
    expect(canonicalUrl("https://blog.example/")).toBe("https://blog.example/");
    expect(canonicalUrl("https://blog.example/p?id=7&utm_medium=a")).toBe("https://blog.example/p?id=7");
    expect(canonicalUrl("https://blog.example/p?source=rss---abc&fbclid=1&gclid=2")).toBe("https://blog.example/p");
  });
});

describe("articleLinksFromListing", () => {
  it("keeps same-host article links only, deduped by canonical url, capped", () => {
    const links = [
      "https://blog.example/p/one",
      "https://blog.example/tag/ai",
      "https://blog.example/author/me",
      "https://blog.example/category/x",
      "https://blog.example/page/2",
      "https://other.site/p/x",
      "https://blog.example/p/one?utm_source=a",
      "mailto:a@b.c",
      "https://blog.example/",
    ];
    expect(articleLinksFromListing("https://blog.example/", links, 5)).toEqual(["https://blog.example/p/one"]);
    const many = Array.from({ length: 8 }, (_, i) => `https://blog.example/p/${i}`);
    expect(articleLinksFromListing("https://blog.example/", many, 5)).toHaveLength(5);
  });
});

describe("articleLinksFromListing on a section page", () => {
  it("drops the site root, the listing itself, its query variants, ancestors and utility pages", () => {
    const links = [
      "https://blog.example/",
      "https://blog.example/opini",
      "https://blog.example/opini?page=2",
      "https://blog.example/about",
      "https://blog.example/login",
      "https://blog.example/subscribe",
      "https://blog.example/search",
      "https://blog.example/penulis/dina",
      "https://blog.example/kategori/ekonomi",
      "https://blog.example/topik/ai",
      "https://blog.example/tentang",
      "https://blog.example/opini/esai-satu",
    ];
    expect(articleLinksFromListing("https://blog.example/opini", links, 10)).toEqual([
      "https://blog.example/opini/esai-satu",
    ]);
  });
});

describe("titleFromMarkdown", () => {
  it("uses the first heading, else the url slug", () => {
    expect(titleFromMarkdown("intro\n# Real Title\nbody", "https://b.example/p/x")).toBe("Real Title");
    expect(titleFromMarkdown("no heading", "https://b.example/p/my-first-post")).toBe("my first post");
    expect(titleFromMarkdown("", "https://www.paulgraham.com/schlep.html")).toBe("schlep");
  });
});

describe("FakeCrawler and createCrawler", () => {
  it("serves configured data and fails on demand", async () => {
    const fake = new FakeCrawler({
      listings: { "https://b.example/": ["https://b.example/p/1"] },
      failOn: ["https://b.example/bad"],
    });
    expect(await fake.listing("https://b.example/")).toEqual(["https://b.example/p/1"]);
    await expect(fake.listing("https://b.example/bad")).rejects.toThrow();
  });
  it("picks a provider from env", () => {
    expect(createCrawler({})).toBeInstanceOf(FakeCrawler);
    expect(() => createCrawler({ CRAWLER_PROVIDER: "tavily" })).toThrow("TAVILY_API_KEY is required");
    expect(createCrawler({ CRAWLER_PROVIDER: "tavily", TAVILY_API_KEY: "k" })).toBeInstanceOf(TavilyCrawler);
    expect(() => createCrawler({ CRAWLER_PROVIDER: "x" })).toThrow("unknown CRAWLER_PROVIDER");
  });
});

describe("TavilyCrawler", () => {
  it("listing posts to map with a bearer token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: ["https://b.example/p/1", "https://b.example/p/2"] }));
    const crawler = new TavilyCrawler("secret-key", fetchImpl as unknown as typeof fetch, async () => {});
    const links = await crawler.listing("https://b.example/");
    expect(links).toEqual(["https://b.example/p/1", "https://b.example/p/2"]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.tavily.com/map");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
    expect(JSON.parse(init.body as string)).toMatchObject({ url: "https://b.example/" });
  });

  it("article posts to extract and maps raw content", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ results: [{ url: "https://b.example/p/1", raw_content: "# Hello\n\nBody text here." }], failed_results: [] }),
    );
    const crawler = new TavilyCrawler("secret-key", fetchImpl as unknown as typeof fetch, async () => {});
    const article = await crawler.article("https://b.example/p/1");
    expect(article).toMatchObject({
      url: "https://b.example/p/1",
      title: "Hello",
      author: null,
      publishedAt: null,
    });
    expect(article.text).toContain("Body text here.");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.tavily.com/extract");
    expect(JSON.parse(init.body as string)).toMatchObject({ urls: ["https://b.example/p/1"], format: "markdown" });
  });

  it("flags a title it had to guess from the url", async () => {
    const make = (raw: string) =>
      new TavilyCrawler(
        "k",
        (async () => jsonResponse({ results: [{ url: "https://b.example/p/x", raw_content: raw }] })) as unknown as typeof fetch,
        async () => {},
      );
    expect((await make("# Judul\n\nisi").article("https://b.example/p/x")).titleGuessed).toBe(false);
    expect((await make("| a | b |\n\nisi").article("https://b.example/p/x")).titleGuessed).toBe(true);
  });

  it("throws without leaking the key", async () => {
    const empty = new TavilyCrawler("secret-key", (async () => jsonResponse({ results: [], failed_results: [] })) as unknown as typeof fetch, async () => {});
    await expect(empty.article("https://b.example/p/9")).rejects.toThrow("https://b.example/p/9");
    const bad = new TavilyCrawler("secret-key", (async () => jsonResponse({ detail: "secret-key nope" }, 401)) as unknown as typeof fetch, async () => {});
    const error = await bad.listing("https://b.example/").catch((e: Error) => e);
    expect((error as Error).message).toContain("401");
    expect((error as Error).message).not.toContain("secret-key");
  });
});
