/**
 * Public discussion retrieval via the Hacker News Algolia API.
 *
 * searchPublicDiscussion(company, role?) returns publicly available HN threads
 * matching the company (role used to refine relevance). No API key required.
 * "Nothing found" is a normal result ({ found: false, results: [] }), not an
 * error. Network/API failures are handled gracefully (also return empty).
 *
 * Independent of the LLM.
 */

export interface DiscussionResult {
  title: string;
  url: string;
  points?: number;
  created_at?: string;
}

export interface SearchPublicDiscussionResult {
  found: boolean;
  results: DiscussionResult[];
}

export interface SearchDiscussionOptions {
  /** Injectable fetch (for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** Max results to return. */
  limit?: number;
}

const HN_SEARCH_ENDPOINT = "https://hn.algolia.com/api/v1/search";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_LIMIT = 5;

/** Shape of the bits of the Algolia response we use. */
interface AlgoliaHit {
  objectID?: string;
  title?: string;
  story_title?: string;
  url?: string;
  story_url?: string;
  points?: number;
  created_at?: string;
}

/** Build the HN item URL as a stable fallback when a hit has no external URL. */
function hnItemUrl(objectID: string | undefined): string | undefined {
  return objectID ? `https://news.ycombinator.com/item?id=${objectID}` : undefined;
}

export async function searchPublicDiscussion(
  company: string,
  role?: string,
  options: SearchDiscussionOptions = {},
): Promise<SearchPublicDiscussionResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = options.limit ?? DEFAULT_LIMIT;

  const query = role ? `${company} ${role}` : company;
  const url = `${HN_SEARCH_ENDPOINT}?query=${encodeURIComponent(query)}&tags=story`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let hits: AlgoliaHit[];
  try {
    const res = await doFetch(url, { signal: controller.signal });
    if (!res.ok) {
      return { found: false, results: [] }; // treat API errors as "nothing found"
    }
    const data = (await res.json()) as { hits?: AlgoliaHit[] };
    hits = Array.isArray(data.hits) ? data.hits : [];
  } catch {
    // Timeout / network / parse failure -> graceful empty result.
    return { found: false, results: [] };
  } finally {
    clearTimeout(timer);
  }

  const seen = new Set<string>();
  const results: DiscussionResult[] = [];

  for (const hit of hits) {
    const title = hit.title ?? hit.story_title;
    const link = hit.url ?? hit.story_url ?? hnItemUrl(hit.objectID);
    if (!title || !link) continue;

    if (seen.has(link)) continue; // 11. dedupe URLs
    seen.add(link);

    const result: DiscussionResult = { title, url: link };
    if (typeof hit.points === "number") result.points = hit.points;
    if (hit.created_at) result.created_at = hit.created_at;
    results.push(result);

    if (results.length >= limit) break; // 10. limit results
  }

  return { found: results.length > 0, results };
}
