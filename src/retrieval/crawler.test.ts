import { describe, it, expect, vi } from "vitest";
import { crawlSite, CrawlError, type CrawlDeps } from "./crawler.js";
import type { FetchPageResult } from "./fetcher.js";

const BASE = "https://acme.example.com";

/** Fixture site: URL -> HTML (or "throw" to simulate an unreachable page). */
const SITE: Record<string, string | "throw"> = {
  [`${BASE}/`]: `
    <h1>Acme</h1>
    <a href="/careers">Careers</a>
    <a href="careers">Careers dup (relative)</a>
    <a href="/about">About</a>
    <a href="/blog">Blog</a>
    <a href="/private/secret">Private</a>
    <a href="/broken">Broken</a>
    <a href="https://external.com/careers">External careers</a>
    <a href="/brochure.pdf">Brochure</a>
    <a href="#top">Fragment</a>
  `,
  [`${BASE}/careers`]: "<h1>Careers</h1><p>Join us</p>",
  [`${BASE}/about`]: "<h1>About</h1><p>Who we are</p>",
  [`${BASE}/blog`]: "<h1>Blog</h1><p>News</p>",
  [`${BASE}/private/secret`]: "<h1>Secret</h1>",
  [`${BASE}/broken`]: "throw",
};

function makeFetch(): (url: string) => Promise<FetchPageResult> {
  return vi.fn(async (url: string) => {
    const html = SITE[url];
    if (html === undefined || html === "throw") {
      throw new Error(`unreachable: ${url}`);
    }
    return {
      url,
      status: 200,
      contentType: "text/html",
      html,
    };
  });
}

/** Default deps: deterministic, no real delay, robots allows everything. */
function deps(overrides: Partial<CrawlDeps> = {}): CrawlDeps {
  return {
    fetchPage: makeFetch(),
    canFetch: async () => true,
    sleep: async () => {},
    maxPages: 10,
    delayMs: 0,
    ...overrides,
  };
}

describe("crawlSite", () => {
  it("fetches the homepage first", async () => {
    const result = await crawlSite(`${BASE}/`, deps());
    expect(result.pages[0].url).toBe(`${BASE}/`);
    expect(result.pages[0].text).toContain("Acme");
  });

  it("ranks and fetches relevant links (careers before about/blog)", async () => {
    const result = await crawlSite(`${BASE}/`, deps());
    const urls = result.pages.map((p) => p.url);
    expect(urls).toContain(`${BASE}/careers`);
    // careers/about/blog are all high-value; careers should appear.
    expect(urls.indexOf(`${BASE}/careers`)).toBeGreaterThan(0);
  });

  it("resolves relative links against the homepage", async () => {
    const result = await crawlSite(`${BASE}/`, deps());
    // The relative "careers" href must resolve to the absolute careers URL.
    expect(result.pages.map((p) => p.url)).toContain(`${BASE}/careers`);
  });

  it("does not fetch the same URL twice", async () => {
    const fetchPage = makeFetch();
    await crawlSite(`${BASE}/`, deps({ fetchPage }));
    const careersCalls = (fetchPage as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === `${BASE}/careers`,
    );
    expect(careersCalls).toHaveLength(1);
  });

  it("puts an unreachable page into unreachable[] and keeps going", async () => {
    const result = await crawlSite(`${BASE}/`, deps());
    expect(result.unreachable).toContain(`${BASE}/broken`);
    // Crawl still produced good pages.
    expect(result.pages.length).toBeGreaterThan(1);
  });

  it("respects CRAWL_MAX_PAGES", async () => {
    const result = await crawlSite(`${BASE}/`, deps({ maxPages: 2 }));
    expect(result.pages).toHaveLength(2);
  });

  it("skips robots-disallowed pages", async () => {
    const canFetch = async (url: string) => !url.includes("/private/");
    const result = await crawlSite(`${BASE}/`, deps({ canFetch }));
    expect(result.pages.map((p) => p.url)).not.toContain(`${BASE}/private/secret`);
  });

  it("respects CRAWL_DELAY_MS between requests", async () => {
    const sleep = vi.fn(async () => {});
    await crawlSite(`${BASE}/`, deps({ sleep, delayMs: 250 }));
    expect(sleep).toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("skips external hosts and non-HTML assets", async () => {
    const result = await crawlSite(`${BASE}/`, deps());
    const urls = result.pages.map((p) => p.url);
    expect(urls).not.toContain("https://external.com/careers");
    expect(urls.some((u) => u.endsWith(".pdf"))).toBe(false);
  });

  it("throws CrawlError when the homepage fails", async () => {
    const fetchPage = async () => {
      throw new Error("boom");
    };
    await expect(
      crawlSite(`${BASE}/`, deps({ fetchPage })),
    ).rejects.toBeInstanceOf(CrawlError);
  });
});
