/**
 * Deterministic link ranking to prioritise company-research pages.
 *
 * rankLinks(baseUrl, links) de-duplicates and returns links sorted by descending
 * relevance. Scoring is a pure function of the URL string (+ optional baseUrl),
 * with no fetching and no LLM.
 */

const HIGH_VALUE = [
  "careers",
  "career",
  "jobs",
  "hiring",
  "interview",
  "engineering",
  "about",
  "company",
  "handbook",
  "blog",
];

const MEDIUM_VALUE = [
  "team",
  "culture",
  "life",
  "work",
  "technology",
  "product",
];

const HIGH_SCORE = 10;
const MEDIUM_SCORE = 4;
const SAME_HOST_BONUS = 5;
const CLEAN_PAGE_BONUS = 2;
const NON_HTML_PENALTY = 8;

/** File extensions that are clearly not readable HTML pages. */
const NON_HTML_EXT =
  /\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|mp3|css|js|json|xml|ico|woff2?|ttf)$/i;

/**
 * Score a single link. Higher = more relevant. Deterministic.
 * `baseUrl` (optional) enables the same-hostname preference.
 */
export function scoreLink(link: string, baseUrl?: string): number {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return -Infinity; // unusable
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return -Infinity;
  }

  const haystack = `${url.pathname}${url.search}`.toLowerCase();
  let score = 0;

  for (const kw of HIGH_VALUE) {
    if (haystack.includes(kw)) score += HIGH_SCORE;
  }
  for (const kw of MEDIUM_VALUE) {
    if (haystack.includes(kw)) score += MEDIUM_SCORE;
  }

  // Same-hostname preference.
  if (baseUrl) {
    try {
      if (new URL(baseUrl).hostname === url.hostname) {
        score += SAME_HOST_BONUS;
      }
    } catch {
      // ignore malformed baseUrl
    }
  }

  // Prefer clean HTML pages; penalise obvious asset/file URLs.
  if (NON_HTML_EXT.test(url.pathname)) {
    score -= NON_HTML_PENALTY;
  } else {
    score += CLEAN_PAGE_BONUS;
  }

  return score;
}

export function rankLinks(baseUrl: string, links: string[]): string[] {
  // Deduplicate while preserving first-seen order (stable input order).
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (!seen.has(link)) {
      seen.add(link);
      unique.push(link);
    }
  }

  // Sort by descending score; ties keep original input order (stable).
  return unique
    .map((link, index) => ({ link, index, score: scoreLink(link, baseUrl) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.link);
}
