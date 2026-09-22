import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";
import { AuthError } from "./errors.js";

describe("password hashing/verification", () => {
  it("hashes to a scrypt string that does not contain the plaintext", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash.split("$")).toHaveLength(3);
    expect(hash).not.toContain("correct horse battery staple");
  });

  it("uses a fresh salt so the same password hashes differently each time", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("verifies a correct password and rejects an incorrect one", async () => {
    const hash = await hashPassword("s3cret-password");
    expect(await verifyPassword("s3cret-password", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("returns false (never throws) for malformed stored hashes", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$aa$bb")).toBe(false);
    expect(await verifyPassword("x", "scrypt$only-two")).toBe(false);
  });

  it("rejects empty passwords at hashing time", async () => {
    await expect(hashPassword("")).rejects.toBeInstanceOf(AuthError);
  });
});
