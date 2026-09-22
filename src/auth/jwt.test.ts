import { describe, it, expect } from "vitest";
import { signJwt, verifyJwt } from "./jwt.js";
import { AuthError } from "./errors.js";

const SECRET = "test-signing-secret";

describe("JWT creation/verification", () => {
  it("signs and verifies a token, round-tripping the claims", () => {
    const token = signJwt({ sub: "user-1", email: "a@example.com" }, { secret: SECRET });
    const payload = verifyJwt(token, { secret: SECRET });

    expect(payload.sub).toBe("user-1");
    expect(payload.email).toBe("a@example.com");
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it("rejects a token verified with the wrong secret", () => {
    const token = signJwt({ sub: "u", email: "a@example.com" }, { secret: SECRET });
    expect(() => verifyJwt(token, { secret: "other-secret" })).toThrow(AuthError);
  });

  it("rejects a tampered payload (signature mismatch)", () => {
    const token = signJwt({ sub: "u", email: "a@example.com" }, { secret: SECRET });
    const [h, , s] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "admin", email: "a@example.com", iat: 1, exp: 9_999_999_999 }),
    ).toString("base64url");
    const tampered = `${h}.${forged}.${s}`;
    expect(() => verifyJwt(tampered, { secret: SECRET })).toThrow(/signature/);
  });

  it("rejects an expired token", () => {
    // Issue a token that expired an hour ago (clock fixed in the past).
    const token = signJwt(
      { sub: "u", email: "a@example.com" },
      { secret: SECRET, expiresInSec: 60, now: () => 1_000_000 },
    );
    const err = (() => {
      try {
        verifyJwt(token, { secret: SECRET, now: () => 5_000_000 });
      } catch (e) {
        return e as AuthError;
      }
    })();
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe("token_expired");
  });

  it("rejects malformed tokens", () => {
    expect(() => verifyJwt("", { secret: SECRET })).toThrow(AuthError);
    expect(() => verifyJwt("only.two", { secret: SECRET })).toThrow(AuthError);
    expect(() => verifyJwt("a.b.c", { secret: SECRET })).toThrow(AuthError);
  });
});
