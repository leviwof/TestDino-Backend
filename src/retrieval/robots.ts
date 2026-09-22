/**
 * Minimal robots.txt check.
 *
 * canFetchAccordingToRobots(url) fetches the origin's /robots.txt and applies
 * only `User-agent: *` + `Disallow:` rules. No caching, no Allow rules, no
 * crawl-delay — intentionally tiny. Fails open (returns true) on 404 or error.
 */

export interface RobotsOptions {
  /** Injectable fetch (for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Extract the Disallow paths under the `User-agent: *` group. */
function parseWildcardDisallows(robotsTxt: string): string[] {
  const disallows: string[] = [];
  let inWildcardGroup = false;

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      inWildcardGroup = value === "*";
    } else if (field === "disallow" && inWildcardGroup) {
      if (value !== "") disallows.push(value);
    }
  }
  return disallows;
}

export async function canFetchAccordingToRobots(
  url: string,
  options: RobotsOptions = {},
): Promise<boolean> {
  const doFetch = options.fetchImpl ?? fetch;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return true; // Not our job to validate URLs here; fail open.
  }

  const robotsUrl = `${target.origin}/robots.txt`;

  let res: Response;
  try {
    res = await doFetch(robotsUrl, { method: "GET" });
  } catch {
    return true; // Request failed → allow.
  }

  if (res.status === 404) return true;
  if (!res.ok) return true;

  let body: string;
  try {
    body = await res.text();
  } catch {
    return true;
  }

  const disallows = parseWildcardDisallows(body);
  const path = target.pathname || "/";

  for (const rule of disallows) {
    if (path.startsWith(rule)) return false;
  }
  return true;
}
