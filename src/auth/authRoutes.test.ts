import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp } from "../app.js";
import { signJwt, verifyJwt } from "./jwt.js";
import type { AuthDeps, UserRecord, UserRepository } from "./authService.js";

const SECRET = "route-test-secret";

/** In-memory user repository so route tests never touch MongoDB. */
function memoryRepo(): UserRepository {
  const records: UserRecord[] = [];
  let seq = 0;
  return {
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

/** Auth deps wired to a test secret so no env JWT_SECRET is required. */
function testDeps(): AuthDeps {
  return {
    users: memoryRepo(),
    signToken: (claims, opts) => signJwt(claims, { ...opts, secret: SECRET }),
    verifyToken: (token, opts) => verifyJwt(token, { ...opts, secret: SECRET }),
  };
}

describe("auth HTTP routes", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    const app = createApp({ authDeps: testDeps() });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { headers });

  it("POST /auth/register creates a user (201) and returns a safe user", async () => {
    const res = await post("/auth/register", {
      email: "New@Example.com",
      password: "password123",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user).toEqual({ id: "u1", email: "new@example.com" });
    expect(body.user.passwordHash).toBeUndefined();
    expect(body.token).toBeUndefined();
  });

  it("POST /auth/register rejects an invalid body with 400", async () => {
    const res = await post("/auth/register", {
      email: "not-an-email",
      password: "short",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation_error");
  });

  it("POST /auth/register rejects a duplicate email with 409", async () => {
    await post("/auth/register", { email: "dup@example.com", password: "password123" });
    const res = await post("/auth/register", {
      email: "dup@example.com",
      password: "password123",
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("email_taken");
  });

  it("POST /auth/login returns 200 with a token, and /auth/me accepts it", async () => {
    await post("/auth/register", { email: "user@example.com", password: "password123" });

    const loginRes = await post("/auth/login", {
      email: "user@example.com",
      password: "password123",
    });
    expect(loginRes.status).toBe(200);
    const { user, token } = await loginRes.json();
    expect(user).toEqual({ id: "u1", email: "user@example.com" });
    expect(typeof token).toBe("string");

    const meRes = await get("/auth/me", { authorization: `Bearer ${token}` });
    expect(meRes.status).toBe(200);
    expect((await meRes.json()).user).toEqual({ id: "u1", email: "user@example.com" });
  });

  it("POST /auth/login returns 401 for wrong credentials", async () => {
    await post("/auth/register", { email: "user@example.com", password: "password123" });
    const res = await post("/auth/login", {
      email: "user@example.com",
      password: "wrong-password",
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("invalid_credentials");
  });

  it("GET /auth/me returns 401 without a token", async () => {
    const res = await get("/auth/me");
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("missing_token");
  });

  it("GET /auth/me returns 401 for an invalid token", async () => {
    const res = await get("/auth/me", { authorization: "Bearer not.a.jwt" });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("invalid_token");
  });
});
