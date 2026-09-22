import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp } from "../app.js";
import { signJwt, verifyJwt } from "../auth/jwt.js";
import type { AuthDeps } from "../auth/authService.js";
import type { KitRecord, KitRepository } from "./kitRoutes.js";

const SECRET = "kit-job-test-secret";

const authDeps: AuthDeps = {
  signToken: (claims, opts) => signJwt(claims, { ...opts, secret: SECRET }),
  verifyToken: (token, opts) => verifyJwt(token, { ...opts, secret: SECRET }),
};
const tokenFor = (sub: string) => signJwt({ sub, email: `${sub}@x.com` }, { secret: SECRET });

const VALID_BODY = {
  jd: "Senior Backend Engineer. TypeScript, Node.js, PostgreSQL.",
  company_url: "https://northwind.example.com",
  days: 5,
};

/** In-memory kit store exposing its records. */
function memoryKitRepo(): KitRepository & { records: KitRecord[] } {
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

/** In-memory job creator; records what the route asks it to enqueue. */
function memoryJobCreator() {
  const jobs: Array<{ jobId: string; userId: string; kitId: string; status: string }> = [];
  let n = 0;
  return {
    jobs,
    createJob: async (input: { userId: string; kitId: string }) => {
      const job = { jobId: `job-${++n}`, userId: input.userId, kitId: input.kitId, status: "queued" as const };
      jobs.push(job);
      return { jobId: job.jobId, status: job.status };
    },
  };
}

describe("POST /kits — async job creation boundary", () => {
  let server: Server;
  let base: string;

  const startWith = async (opts: Parameters<typeof createApp>[0]) => {
    const app = createApp(opts);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  };

  afterEach(async () => {
    if (server) await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  });

  const post = (body: unknown, token?: string) =>
    fetch(`${base}/kits`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("creates a kit AND a queued job, returning kitId/jobId/status", async () => {
    const kits = memoryKitRepo();
    const jobCreator = memoryJobCreator();
    await startWith({ authDeps, kitDeps: { kits, createJob: jobCreator.createJob, startExecution: () => {} } });

    const res = await post(VALID_BODY, tokenFor("owner-1"));
    expect(res.status).toBe(201);
    const body = await res.json();

    // Response carries enough for the client to track the job.
    expect(typeof body.kitId).toBe("string");
    expect(typeof body.jobId).toBe("string");
    expect(body.status).toBe("queued");

    // A kit record and exactly one job were created.
    expect(kits.records).toHaveLength(1);
    expect(jobCreator.jobs).toHaveLength(1);
  });

  it("returns a jobId and kitId that match what was persisted", async () => {
    const kits = memoryKitRepo();
    const jobCreator = memoryJobCreator();
    await startWith({ authDeps, kitDeps: { kits, createJob: jobCreator.createJob, startExecution: () => {} } });

    const body = await (await post(VALID_BODY, tokenFor("owner-1"))).json();

    expect(body.kitId).toBe(kits.records[0].id);
    expect(body.jobId).toBe(jobCreator.jobs[0].jobId);
    // The job references the created kit.
    expect(jobCreator.jobs[0].kitId).toBe(body.kitId);
  });

  it("owns the job by the authenticated user (req.user.sub), not the body", async () => {
    const kits = memoryKitRepo();
    const jobCreator = memoryJobCreator();
    await startWith({ authDeps, kitDeps: { kits, createJob: jobCreator.createJob, startExecution: () => {} } });

    // Attempt to spoof ownership via the body — it must be ignored.
    await post({ ...VALID_BODY, userId: "attacker" }, tokenFor("real-owner"));

    expect(kits.records[0].userId).toBe("real-owner");
    expect(jobCreator.jobs[0].userId).toBe("real-owner");
  });

  it("handles job-creation failure safely and rolls back the kit", async () => {
    const kits = memoryKitRepo();
    const failingCreateJob = async () => {
      throw new Error("job store unavailable");
    };
    await startWith({ authDeps, kitDeps: { kits, createJob: failingCreateJob, startExecution: () => {} } });

    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await post(VALID_BODY, tokenFor("owner-1"));

      // Consistent error envelope, generic 500 (no internals leaked in prod).
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe("internal_error");
      expect(JSON.stringify(body)).not.toContain("job store unavailable");

      // Compensating rollback: no orphaned kit left behind.
      expect(kits.records).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it("returns 401 for an unauthenticated request (no kit/job created)", async () => {
    const kits = memoryKitRepo();
    const jobCreator = memoryJobCreator();
    await startWith({ authDeps, kitDeps: { kits, createJob: jobCreator.createJob, startExecution: () => {} } });

    const res = await post(VALID_BODY);
    expect(res.status).toBe(401);
    expect(kits.records).toHaveLength(0);
    expect(jobCreator.jobs).toHaveLength(0);
  });
});
