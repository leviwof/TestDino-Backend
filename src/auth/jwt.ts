import { createHmac, timingSafeEqual } from "node:crypto";
import { loadCliEnv } from "../config/env.js";
import { AuthError } from "./errors.js";

/**
 * Minimal HS256 (HMAC-SHA256) JWT signing/verification using Node's built-in
 * crypto — no external dependency. The signing secret comes from the existing
 * environment config (JWT_SECRET). Signatures are checked in constant time and
 * the algorithm is pinned to HS256 to prevent algorithm-confusion attacks.
 *
 * Access tokens only — refresh tokens are intentionally out of scope.
 */

export interface JwtPayload {
  /** Subject: the user id. */
  sub: string;
  email: string;
  /** Issued-at (seconds since epoch). */
  iat: number;
  /** Expiry (seconds since epoch). */
  exp: number;
}

const DEFAULT_EXPIRES_SEC = 60 * 60; // 1 hour

/** Resolve the signing secret from an explicit value or the environment. */
function resolveSecret(explicit?: string): string {
  const secret = explicit ?? loadCliEnv().JWT_SECRET;
  if (!secret || secret.length === 0) {
    throw new AuthError(
      "JWT secret is not configured (set JWT_SECRET in the environment)",
      "config_error",
      500,
    );
  }
  return secret;
}

export interface SignJwtOptions {
  /** Override the signing secret (defaults to env JWT_SECRET). */
  secret?: string;
  /** Token lifetime in seconds (default 1 hour). */
  expiresInSec?: number;
  /** Injectable clock (ms since epoch) for deterministic tests. */
  now?: () => number;
}

/** Sign an access token for the given user claims. */
export function signJwt(
  claims: { sub: string; email: string },
  opts: SignJwtOptions = {},
): string {
  const secret = resolveSecret(opts.secret);
  const nowMs = opts.now ? opts.now() : Date.now();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + (opts.expiresInSec ?? DEFAULT_EXPIRES_SEC);

  const header = { alg: "HS256", typ: "JWT" };
  const payload: JwtPayload = { sub: claims.sub, email: claims.email, iat, exp };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");

  return `${signingInput}.${signature}`;
}

export interface VerifyJwtOptions {
  secret?: string;
  now?: () => number;
}

/**
 * Verify a token and return its payload. Throws AuthError with a specific code
 * ("invalid_token" or "token_expired") on any failure. The signature is
 * verified BEFORE the payload is trusted.
 */
export function verifyJwt(token: string, opts: VerifyJwtOptions = {}): JwtPayload {
  const secret = resolveSecret(opts.secret);

  if (typeof token !== "string" || token.length === 0) {
    throw new AuthError("token is missing", "invalid_token", 401);
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AuthError("malformed token", "invalid_token", 401);
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  const expectedSig = createHmac("sha256", secret).update(signingInput).digest();
  const providedSig = Buffer.from(signatureB64, "base64url");
  if (
    providedSig.length !== expectedSig.length ||
    !timingSafeEqual(providedSig, expectedSig)
  ) {
    throw new AuthError("invalid token signature", "invalid_token", 401);
  }

  let header: { alg?: string };
  let payload: JwtPayload;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as JwtPayload;
  } catch {
    throw new AuthError("malformed token", "invalid_token", 401);
  }

  // Pin the algorithm to defeat "alg: none" / RS256->HS256 confusion.
  if (header.alg !== "HS256") {
    throw new AuthError("unsupported token algorithm", "invalid_token", 401);
  }

  const nowSec = Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= nowSec) {
    throw new AuthError("token has expired", "token_expired", 401);
  }
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
    throw new AuthError("token is missing required claims", "invalid_token", 401);
  }

  return payload;
}
