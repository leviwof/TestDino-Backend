import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp } from "../app.js";
import { signJwt, verifyJwt } from "../auth/jwt.js";
import type { AuthDeps } from "../auth/authService.js";
import type { KitRecord, KitRepository } from "./kitRoutes.js";

const SECRET = "kit-error-test-secret";

const authDeps: AuthDeps = {
  signToken: (claims, opts) => signJwt(claims, { ...opts, secret: SECRET }),
  verifyToken: (token, opts) => verifyJwt(token, { ...opts, secret: SECRET }),
};
const tokenFor = (sub: string) => signJwt({ sub, email: `${sub}@x.com` }, { secret: SECRET });

const VALID_BODY = {
  jd: "Backend Engineer. TypeScript, Node.js.",
  company_url: "https://acme.example.com",
  days: 3,
};

/** A leak-canary string the server must never echo back to the client. */
const SECRET_INTERNAL = "DB_PASSWORD=hunter2 sk-live-INTERNAL";

/** Repo whose create() blows up with an internal error (no status/code). */
function explodingRepo(): KitRepository {
  return {
    async create() {
      throw new Error(`connection refused: ${SECRET_INTERNAL}`);
    },
    async findByUserAndHash() {
      return null;
    },
    async findByIdForUser() {
      return null;
    },
    async setKitForUser() {
      return null;
    },
    async deleteByIdForUser() {
      // no-op
    },
  };
}

/** Minimal working in-memory repo for the non-error paths. */
function memoryRepo(): KitRepository & { records: KitRecord[] } {
  const records: KitRecord[] = [];
  let seq = 0;
  return {
    records,
    async create(rec) {
      const r: KitRecord = { id: `k${++seq}`, status: "queued", kit: null, ...rec };
      records.push(r);
      return r;
    },
    async findByUserAndHash(u, h) {
      return records.find((r) => r.userId === u && r.inputHash === h) ?? null;
    },
    async findByIdForUser(id, u) {
      return records.find((r) => r.id === id && r.userId === u) ?? null;
    },
    async setKitForUser(id, u, kit) {
      const f = records.find((r) => r.id === id && r.userId === u);
      if (!f) return null;
      f.kit = kit;
      return f;
    },
    async deleteByIdForUser(id, u) {
      const i = records.findIndex((r) => r.id === id && r.userId === u);
      if (i >= 0) records.splice(i, 1);
    },
  };
}

/** Fake job creator so successful POST /kits doesn't reach MongoDB. */
const fakeCreateJob = async (_input: { userId: string; kitId: string }) => ({
  jobId: "job-test",
  status: "queued" as const,
});

function start(app: ReturnType<typeof createApp>) {
  const server = createServer(app);
  return new Promise<{ server: Server; base: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe("Kit API error handling & status behavior", () => {
  let server: Server;
  let base: string;

  afterEach(async () => {
    if (server) await close(server);
  });

  const req = (
    method: string,
    path: string,
    { token, body }: { token?: string; body?: unknown } = {},
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  /** Assert the canonical error envelope: { error: { code, message } }. */
  async function expectErrorShape(res: Response, status: number, code?: string) {
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(typeof body.error.code).toBe("string");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
    if (code) expect(body.error.code).toBe(code);
    return body;
  }

  it("400 for an invalid create request (consistent shape)", async () => {
    ({ server, base } = await start(createApp({ authDeps, kitDeps: { kits: memoryRepo(), createJob: fakeCreateJob, startExecution: () => {} } })));
    const res = await req("POST", "/kits", {
      token: tokenFor("u1"),
      body: { jd: "", company_url: "nope", days: 0 },
    });
    await expectErrorShape(res, 400, "validation_error");
  });

  it("401 for missing/invalid authentication", async () => {
    ({ server, base } = await start(createApp({ authDeps, kitDeps: { kits: memoryRepo(), createJob: fakeCreateJob, startExecution: () => {} } })));
    await expectErrorShape(await req("POST", "/kits", { body: VALID_BODY }), 401, "missing_token");
    await expectErrorShape(
      await req("GET", "/kits/x", { token: "bad.token.here" }),
      401,
      "invalid_token",
    );
  });

  it("404 for a missing kit", async () => {
    ({ server, base } = await start(createApp({ authDeps, kitDeps: { kits: memoryRepo(), createJob: fakeCreateJob, startExecution: () => {} } })));
    await expectErrorShape(
      await req("GET", "/kits/nope", { token: tokenFor("u1") }),
      404,
      "not_found",
    );
  });

  it("404 for unauthorized kit access (another user's kit)", async () => {
    const repo = memoryRepo();
    ({ server, base } = await start(createApp({ authDeps, kitDeps: { kits: repo, createJob: fakeCreateJob, startExecution: () => {} } })));
    const created = await (
      await req("POST", "/kits", { token: tokenFor("owner"), body: VALID_BODY })
    ).json();
    await expectErrorShape(
      await req("GET", `/kits/${created.kit.id}`, { token: tokenFor("intruder") }),
      404,
      "not_found",
    );
  });

  it("500 for an unexpected server error, without leaking internals (production)", async () => {
    ({ server, base } = await start(createApp({ authDeps, kitDeps: { kits: explodingRepo(), createJob: fakeCreateJob, startExecution: () => {} } })));
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await req("POST", "/kits", { token: tokenFor("u1"), body: VALID_BODY });
      const body = await expectErrorShape(res, 500, "internal_error");
      // Generic message; the internal error detail must not appear anywhere.
      expect(body.error.message).toBe("Internal server error");
      expect(JSON.stringify(body)).not.toContain(SECRET_INTERNAL);
      expect(JSON.stringify(body)).not.toContain("connection refused");
      expect(body.error).not.toHaveProperty("stack");
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it("keeps a consistent error envelope across all statuses", async () => {
    ({ server, base } = await start(createApp({ authDeps, kitDeps: { kits: memoryRepo(), createJob: fakeCreateJob, startExecution: () => {} } })));
    const cases = [
      await req("POST", "/kits", { token: tokenFor("u1"), body: {} }), // 400
      await req("GET", "/kits/x"), // 401
      await req("GET", "/kits/missing", { token: tokenFor("u1") }), // 404
    ];
    for (const res of cases) {
      const body = await res.json();
      expect(Object.keys(body)).toEqual(["error"]);
      expect(Object.keys(body.error).sort()).toEqual(
        expect.arrayContaining(["code", "message"]),
      );
    }
  });
});
