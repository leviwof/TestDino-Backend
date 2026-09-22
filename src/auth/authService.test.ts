import { describe, it, expect, beforeEach } from "vitest";
import {
  registerUser,
  loginUser,
  verifyAuthToken,
  type UserRecord,
  type UserRepository,
} from "./authService.js";
import { signJwt, verifyJwt } from "./jwt.js";
import { verifyPassword } from "./password.js";
import { AuthError } from "./errors.js";

const SECRET = "auth-service-test-secret";

/** In-memory user repository so tests never touch MongoDB. */
function memoryRepo(): UserRepository & { records: UserRecord[] } {
  const records: UserRecord[] = [];
  let seq = 0;
  return {
    records,
    async findByEmail(email) {
      return records.find((r) => r.email === email) ?? null;
    },
    async create({ email, passwordHash }) {
      const record: UserRecord = { id: `u${++seq}`, email, passwordHash };
      records.push(record);
      return record;
    },
  };
}

// Sign with the test secret so verification is env-independent.
const signToken: typeof signJwt = (claims, opts) =>
  signJwt(claims, { ...opts, secret: SECRET });

describe("authService.registerUser", () => {
  let users: ReturnType<typeof memoryRepo>;
  beforeEach(() => {
    users = memoryRepo();
  });

  it("stores a hashed password and returns a safe user (no hash)", async () => {
    const user = await registerUser(
      { email: "New@Example.com", password: "password123" },
      { users },
    );

    // Email normalised; no password/hash on the returned object.
    expect(user).toEqual({ id: "u1", email: "new@example.com" });
    expect((user as Record<string, unknown>).passwordHash).toBeUndefined();

    // Stored value is a hash, not the plaintext, and verifies correctly.
    const stored = users.records[0].passwordHash;
    expect(stored).not.toContain("password123");
    expect(await verifyPassword("password123", stored)).toBe(true);
  });

  it("rejects a duplicate email", async () => {
    await registerUser({ email: "dup@example.com", password: "password123" }, { users });
    const err = await registerUser(
      { email: "dup@example.com", password: "password123" },
      { users },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe("email_taken");
  });

  it("rejects invalid input (bad email, short password)", async () => {
    await expect(
      registerUser({ email: "not-an-email", password: "password123" }, { users }),
    ).rejects.toBeTruthy();
    await expect(
      registerUser({ email: "ok@example.com", password: "short" }, { users }),
    ).rejects.toBeTruthy();
  });
});

describe("authService.loginUser", () => {
  let users: ReturnType<typeof memoryRepo>;
  beforeEach(async () => {
    users = memoryRepo();
    await registerUser({ email: "user@example.com", password: "password123" }, { users });
  });

  it("returns a safe user and a verifiable token on correct credentials", async () => {
    const { user, token } = await loginUser(
      { email: "user@example.com", password: "password123" },
      { users, signToken },
    );

    expect(user).toEqual({ id: "u1", email: "user@example.com" });
    const payload = verifyJwt(token, { secret: SECRET });
    expect(payload.sub).toBe("u1");
    expect(payload.email).toBe("user@example.com");
  });

  it("rejects a wrong password with invalid_credentials", async () => {
    const err = await loginUser(
      { email: "user@example.com", password: "wrong-password" },
      { users, signToken },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe("invalid_credentials");
  });

  it("rejects an unknown email with the same generic error", async () => {
    const err = await loginUser(
      { email: "nobody@example.com", password: "password123" },
      { users, signToken },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe("invalid_credentials");
  });
});

describe("authService.verifyAuthToken", () => {
  it("returns the payload for a valid token", () => {
    const token = signJwt({ sub: "u1", email: "user@example.com" }, { secret: SECRET });
    const payload = verifyAuthToken(token, {
      verifyToken: (t, o) => verifyJwt(t, { ...o, secret: SECRET }),
    });
    expect(payload.sub).toBe("u1");
  });

  it("throws on an invalid token", () => {
    expect(() =>
      verifyAuthToken("garbage.token.here", {
        verifyToken: (t, o) => verifyJwt(t, { ...o, secret: SECRET }),
      }),
    ).toThrow(AuthError);
  });
});
