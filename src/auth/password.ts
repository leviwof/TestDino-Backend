import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { AuthError } from "./errors.js";

/**
 * Password hashing using Node's built-in scrypt (memory-hard KDF) — no external
 * dependency. Each hash uses a fresh random salt and is stored in a
 * self-describing string:
 *
 *   scrypt$<saltHex>$<derivedKeyHex>
 *
 * Verification is constant-time (timingSafeEqual). Plaintext passwords are never
 * stored or logged.
 */

const scrypt = promisify(scryptCb);

const ALGORITHM = "scrypt";
const SALT_BYTES = 16;
const KEY_LENGTH = 64;

/** Hash a plaintext password for storage. */
export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new AuthError("password must be a non-empty string", "invalid_password");
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scrypt(plain, salt, KEY_LENGTH)) as Buffer;
  return `${ALGORITHM}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Verify a plaintext password against a stored hash. Returns false (never
 * throws) for malformed/unknown hash formats so it is safe to call on any input.
 */
export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  if (typeof plain !== "string" || typeof stored !== "string") return false;

  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== ALGORITHM) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[1], "hex");
    expected = Buffer.from(parts[2], "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = (await scrypt(plain, salt, expected.length)) as Buffer;
  // Lengths are equal by construction, but guard before timingSafeEqual.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
