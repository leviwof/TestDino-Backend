/**
 * URL security for the web-retrieval layer (SSRF guard).
 *
 * validateFetchUrl(url) resolves if the URL is safe to fetch and rejects with a
 * typed FetchUrlError otherwise. It performs NO network requests — it only
 * inspects the (WHATWG-canonicalised) URL and its host.
 */

export type FetchUrlErrorCode =
  | "FETCH_URL_INVALID"
  | "FETCH_PRIVATE_HOST_BLOCKED"
  | "FETCH_PROTOCOL_NOT_ALLOWED";

export class FetchUrlError extends Error {
  constructor(
    public readonly code: FetchUrlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FetchUrlError";
  }
}

/** Read ALLOW_PRIVATE_HOSTS from the environment (same truthy parsing as config/env). */
function allowPrivateHosts(): boolean {
  const v = process.env.ALLOW_PRIVATE_HOSTS;
  if (typeof v === "string") {
    return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
  }
  return false;
}

function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return octets;
}

function isPrivateIPv4(o: number[]): boolean {
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 (incl. 0.0.0.0)
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/** Expand an IPv6 host (with optional embedded IPv4 tail) into 8 hextets. */
function parseIPv6(host: string): number[] | null {
  if (!host.includes(":")) return null;
  let h = host;

  // Fold an embedded IPv4 tail (e.g. ::ffff:127.0.0.1) into two hextets.
  const lastColon = h.lastIndexOf(":");
  const tail = h.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    h = `${h.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const parts = h.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tailArr = parts.length === 2 ? (parts[1] ? parts[1].split(":") : []) : null;

  let hextets: number[];
  if (tailArr === null) {
    if (head.length !== 8) return null;
    hextets = head.map((x) => parseInt(x, 16));
  } else {
    const missing = 8 - (head.length + tailArr.length);
    if (missing < 0) return null;
    hextets = [
      ...head.map((x) => parseInt(x, 16)),
      ...Array<number>(missing).fill(0),
      ...tailArr.map((x) => parseInt(x, 16)),
    ];
  }
  if (hextets.length !== 8 || hextets.some((x) => Number.isNaN(x) || x < 0 || x > 0xffff)) {
    return null;
  }
  return hextets;
}

function isPrivateIPv6(h: number[]): boolean {
  const firstSeven = h.slice(0, 7).every((x) => x === 0);
  if (firstSeven && (h[7] === 0 || h[7] === 1)) return true; // :: and ::1
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  // IPv4-mapped ::ffff:0:0/96 — inspect the embedded IPv4.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    const v4 = [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff];
    if (isPrivateIPv4(v4)) return true;
  }
  return false;
}

function isBlockedHostname(host: string): boolean {
  const h = host.replace(/\.$/, ""); // drop trailing dot
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const internalSuffixes = [
    ".local",
    ".localdomain",
    ".internal",
    ".intranet",
    ".lan",
    ".home",
    ".corp",
  ];
  if (internalSuffixes.some((s) => h.endsWith(s))) return true;
  // A dot-less single label cannot be a public FQDN — treat as internal.
  if (!h.includes(".")) return true;
  return false;
}

function isBlockedHost(host: string): boolean {
  const v4 = parseIPv4(host);
  if (v4) return isPrivateIPv4(v4);
  if (host.includes(":")) {
    const v6 = parseIPv6(host);
    return v6 ? isPrivateIPv6(v6) : true; // unparseable IPv6 => block
  }
  return isBlockedHostname(host);
}

/**
 * Validate a URL before fetching. Resolves if safe; rejects with FetchUrlError.
 * Does not perform any network request.
 */
export async function validateFetchUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FetchUrlError("FETCH_URL_INVALID", `Malformed URL: ${url}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FetchUrlError(
      "FETCH_PROTOCOL_NOT_ALLOWED",
      `Protocol not allowed: ${parsed.protocol}`,
    );
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new FetchUrlError(
      "FETCH_URL_INVALID",
      "Credentials embedded in URL are not allowed",
    );
  }

  if (allowPrivateHosts()) return;

  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isBlockedHost(host)) {
    throw new FetchUrlError(
      "FETCH_PRIVATE_HOST_BLOCKED",
      `Private/local host is blocked: ${parsed.hostname}`,
    );
  }
}
