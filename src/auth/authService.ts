import { z } from "zod";
import { UserModel } from "../models/User.js";
import { AuthError } from "./errors.js";
import { hashPassword, verifyPassword } from "./password.js";
import { signJwt, verifyJwt, type JwtPayload } from "./jwt.js";

/**
 * Authentication service: register, login, and token verification.
 *
 * Passwords are hashed with scrypt before storage (see password.ts) and access
 * tokens are HS256 JWTs signed with the configured JWT_SECRET (see jwt.ts).
 * All persistence goes through an injectable UserRepository so the logic can be
 * unit-tested without a live MongoDB. Returned user objects are always "safe":
 * they never include the password hash.
 *
 * Refresh tokens and HTTP routes are intentionally out of scope.
 */

// ---- Public shapes ----

/** A user object safe to return to clients (no password hash). */
export interface SafeUser {
  id: string;
  email: string;
}

const CredentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email("a valid email is required"),
  password: z
    .string()
    .min(8, "password must be at least 8 characters")
    .max(200, "password is too long"),
});

export type Credentials = z.infer<typeof CredentialsSchema>;

// ---- Persistence port ----

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
}

export interface UserRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  create(input: { email: string; passwordHash: string }): Promise<UserRecord>;
}

export interface AuthDeps {
  /** Injectable user store (defaults to a MongoDB-backed repository). */
  users?: UserRepository;
  /** Injectable token signer (defaults to signJwt). */
  signToken?: typeof signJwt;
  /** Injectable token verifier (defaults to verifyJwt). */
  verifyToken?: typeof verifyJwt;
  /** Injectable clock for token timestamps. */
  now?: () => number;
}

/** Default MongoDB-backed repository (used when no repository is injected). */
function mongoUserRepository(): UserRepository {
  return {
    async findByEmail(email) {
      const doc = await UserModel.findOne({ email }).lean().exec();
      if (!doc) return null;
      return {
        id: String(doc._id),
        email: doc.email,
        passwordHash: doc.passwordHash,
      };
    },
    async create({ email, passwordHash }) {
      const doc = await UserModel.create({ email, passwordHash });
      return {
        id: String(doc._id),
        email: doc.email,
        passwordHash: doc.passwordHash,
      };
    },
  };
}

function toSafeUser(record: UserRecord): SafeUser {
  return { id: record.id, email: record.email };
}

// A well-formed hash verified against when a user is not found, to keep login
// timing similar whether or not the email exists (reduces user enumeration).
let dummyHashPromise: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword("not-a-real-password-placeholder");
  }
  return dummyHashPromise;
}

// ---- Operations ----

/**
 * Register a new user. Validates input, rejects duplicate emails, hashes the
 * password, and returns the safe user object.
 */
export async function registerUser(
  input: unknown,
  deps: AuthDeps = {},
): Promise<SafeUser> {
  const { email, password } = CredentialsSchema.parse(input);
  const users = deps.users ?? mongoUserRepository();

  const existing = await users.findByEmail(email);
  if (existing) {
    throw new AuthError("email is already registered", "email_taken", 409);
  }

  const passwordHash = await hashPassword(password);
  const record = await users.create({ email, passwordHash });
  return toSafeUser(record);
}

/**
 * Log a user in. Returns a safe user object plus a signed access token. Throws a
 * generic "invalid_credentials" error for both unknown email and wrong password.
 */
export async function loginUser(
  input: unknown,
  deps: AuthDeps = {},
): Promise<{ user: SafeUser; token: string }> {
  const { email, password } = CredentialsSchema.parse(input);
  const users = deps.users ?? mongoUserRepository();
  const sign = deps.signToken ?? signJwt;

  const record = await users.findByEmail(email);
  const ok = record
    ? await verifyPassword(password, record.passwordHash)
    : // Burn comparable time so a missing email is not distinguishable.
      (await verifyPassword(password, await getDummyHash()), false);

  if (!record || !ok) {
    throw new AuthError("invalid email or password", "invalid_credentials", 401);
  }

  const token = sign(
    { sub: record.id, email: record.email },
    deps.now ? { now: deps.now } : {},
  );
  return { user: toSafeUser(record), token };
}

/**
 * Verify an access token and return its payload. Throws AuthError on any invalid
 * or expired token.
 */
export function verifyAuthToken(
  token: string,
  deps: Pick<AuthDeps, "verifyToken" | "now"> = {},
): JwtPayload {
  const verify = deps.verifyToken ?? verifyJwt;
  return verify(token, deps.now ? { now: deps.now } : {});
}
