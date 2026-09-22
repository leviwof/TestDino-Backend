import { fetchPage, type FetchPageResult } from "./fetcher.js";
import { cleanHtml } from "./htmlCleaner.js";
import { extractLinks } from "./linkExtractor.js";
import { rankLinks } from "./linkRanker.js";
import { canFetchAccordingToRobots } from "./robots.js";

/**
 * Basic company-website crawler. Fetches the homepage, extracts + ranks links,
 * then fetches the top same-host pages up to CRAWL_MAX_PAGES, respecting
 * robots.txt and CRAWL_DELAY_MS. Deterministic, no LLM.
 *
 * One discovered page failing does not fail the crawl (its URL goes into
 * `unreachable`). If the homepage itself fails, a CrawlError is thrown.
 */

export interface CrawledPage {
  url: string;
  status: number;
  text: string;
}

export interface CrawlResult {
  pages: CrawledPage[];
  unreachable: string[];
}

export class CrawlError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CrawlError";
  }
}

/** Injectable dependencies (for tests). Defaults use the real modules/env. */
export interface CrawlDeps {
  fetchPage?: (url: string) => Promise<FetchPageResult>;
  canFetch?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  maxPages?: number;
  delayMs?: number;
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Obvious non-HTML assets we never want to crawl. */
const NON_HTML_EXT =
  /\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|mp3|css|js|json|xml|ico|woff2?|ttf)$/i;

function isSameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

function isCrawlable(link: string, startUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (!isSameHost(link, startUrl)) return false; // prefer/limit to same host
  if (NON_HTML_EXT.test(u.pathname)) return false; // skip irrelevant resources
  return true;
}

export async function crawlSite(
  startUrl: string,
  deps: CrawlDeps = {},
): Promise<CrawlResult> {
  const doFetch = deps.fetchPage ?? ((url: string) => fetchPage(url));
  const canFetch =
    deps.canFetch ?? ((url: string) => canFetchAccordingToRobots(url));
  const sleep = deps.sleep ?? realSleep;
  const maxPages = deps.maxPages ?? envInt("CRAWL_MAX_PAGES", 10);
  const delayMs = deps.delayMs ?? envInt("CRAWL_DELAY_MS", 500);

  const pages: CrawledPage[] = [];
  const unreachable: string[] = [];
  const visited = new Set<string>();

  // 1-3. Fetch the homepage. Failure here is fatal.
  let home: FetchPageResult;
  try {
    home = await doFetch(startUrl);
  } catch (err) {
    throw new CrawlError(`Failed to fetch homepage: ${startUrl}`, err);
  }
  visited.add(startUrl);
  visited.add(home.url); // dedupe on final (redirected) URL too
  pages.push({ url: home.url, status: home.status, text: cleanHtml(home.html) });

  if (pages.length >= maxPages) return { pages, unreachable };

  // 4-6. Extract + rank candidate links from the homepage.
  const links = extractLinks(home.url, home.html);
  const candidates = rankLinks(startUrl, links).filter((l) =>
    isCrawlable(l, startUrl),
  );

  // 7,12. Fetch top-ranked pages until we hit the page cap.
  for (const url of candidates) {
    if (pages.length >= maxPages) break;
    if (visited.has(url)) continue; // 12. never fetch the same URL twice
    visited.add(url);

    // 10. Respect robots.txt.
    let allowed = true;
    try {
      allowed = await canFetch(url);
    } catch {
      allowed = true; // robots check failing shouldn't block the crawl
    }
    if (!allowed) continue; // 8. skip robots-disallowed pages

    // 11. Politeness delay between requests.
    if (delayMs > 0) await sleep(delayMs);

    // 13. A single failure records the URL and continues.
    try {
      const res = await doFetch(url);
      if (visited.has(res.url) && res.url !== url) {
        // Redirected to something already fetched; skip storing a dup.
        continue;
      }
      visited.add(res.url);
      pages.push({
        url: res.url,
        status: res.status,
        text: cleanHtml(res.html),
      });
    } catch {
      unreachable.push(url);
    }
  }

  return { pages, unreachable };
}
