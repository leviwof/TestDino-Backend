/**
 * Minimal link extraction.
 *
 * extractLinks(baseUrl, html) pulls href values from <a> elements, resolves them
 * to absolute http(s) URLs against baseUrl, drops fragments, and de-duplicates.
 * It does NOT fetch, rank, or crawl.
 */

/** Match href="...", href='...', or href=unquoted on <a> tags. */
const HREF_RE = /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))[^>]*>/gi;

const IGNORED_SCHEMES = ["mailto:", "tel:", "javascript:", "data:"];

function isIgnored(href: string): boolean {
  const h = href.trim();
  if (h === "") return true;
  if (h.startsWith("#")) return true; // fragment-only
  const lower = h.toLowerCase();
  return IGNORED_SCHEMES.some((s) => lower.startsWith(s));
}

/** Resolve + normalize a single href against baseUrl; return null if unusable. */
function normalize(baseUrl: string, href: string): string | null {
  let abs: URL;
  try {
    abs = new URL(href, baseUrl);
  } catch {
    return null;
  }

  if (abs.protocol !== "http:" && abs.protocol !== "https:") return null;

  // Drop fragment; keep query (useful params preserved as-is).
  abs.hash = "";

  return abs.toString();
}

export function extractLinks(baseUrl: string, html: string): string[] {
  if (!html) return [];

  const seen = new Set<string>();
  const out: string[] = [];

  for (const m of html.matchAll(HREF_RE)) {
    const raw = m[2] ?? m[3] ?? m[4] ?? "";
    if (isIgnored(raw)) continue;

    const normalized = normalize(baseUrl, raw);
    if (!normalized) continue;

    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }

  return out;
}
