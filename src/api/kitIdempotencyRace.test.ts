import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp } from "../app.js";
import { signJwt, verifyJwt } from "../auth/jwt.js";
import type { AuthDeps } from "../auth/authService.js";
import { KitConflictError, type KitRecord, type KitRepository } from "./kitRoutes.js";

const SECRET = "kit-idem-race-secret";
const authDeps: AuthDeps = {
  signToken: (claims, opts) => signJwt(claims, { ...opts, secret: SECRET }),
  verifyToken: (token, opts) => verifyJwt(token, { ...opts, secret: SECRET }),
};
const tokenFor = (sub: string) => signJwt({ sub, email: `${sub}@x.com` }, { secret: SECRET });

const BODY = {
  jd: "Senior Backend Engineer. TypeScript, Node.js.",
  company_url: "https://northwind.example.com",
  days: 5,
};

/**
 * In-memory repo that enforces the (userId, inputHash) uniqueness constraint the
 * same way the Mongo unique index does: a second create for the same key throws
 * KitConflictError. Also injects a small async yield so concurrent handlers can
 * both pass the pre-check before either commits (reproducing the race).
 */
function racingRepo(): KitRepository & { records: KitRecord[]; createCalls: number } {
  const state = { records: [] as KitRecord[], createCalls: 0 };
  let seq = 0;
  return {
    get records() {
      return state.records;
    },
    get createCalls() {
      return state.createCalls;
    },
    async create(rec) {
      state.createCalls += 1;
      await Promise.resolve(); // yield, widening the race window
      if (state.records.some((r) => r.userId === rec.userId && r.inputHash === rec.inputHash)) {
        throw new KitConflictError();
      }
      const r: KitRecord = { id: `k${++seq}`, status: "queued", kit: null, jobId: null, ...rec };
      state.records.push(r);
      return r;
    },
    async findByUserAndHash(u, h) {
      return state.records.find((r) => r.userId === u && r.inputHash === h) ?? null;
    },
    async findByIdForUser(id, u) {
      return state.records.find((r) => r.id === id && r.userId === u) ?? null;
    },
    async setKitForUser() {
      return null;
    },
    async deleteByIdForUser(id, u) {
      const i = state.records.findIndex((r) => r.id === id && r.userId === u);
      if (i >= 0) state.records.splice(i, 1);
    },
    async setJobId(id, u, jobId) {
      const r = state.records.find((x) => x.id === id && x.userId === u);
      if (r) r.jobId = jobId;
    },
  };
}

function jobCreator() {
  const jobs: Array<{ jobId: string; userId: string; kitId: string }> = [];
  let n = 0;
  return {
    jobs,
    createJob: async (input: { userId: string; kitId: string }) => {
      const job = { jobId: `job-${++n}`, userId: input.userId, kitId: input.kitId };
      jobs.push(job);
      return { jobId: job.jobId, status: "queued" as const };
    },
  };
}

describe("POST /kits idempotency under concurrency", () => {
  let server: Server;
  let base: string;
  let kits: ReturnType<typeof racingRepo>;
  let jobs: ReturnType<typeof jobCreator>;
  let started: Array<{ jobId: string; kitId: string; userId: string }>;

  beforeEach(async () => {
    kits = racingRepo();
    jobs = jobCreator();
    started = [];
    const app = createApp({
      authDeps,
      kitDeps: { kits, createJob: jobs.createJob, startExecution: (i) => started.push(i) },
    });
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  });

  const post = (body: unknown, token: string) =>
    fetch(`${base}/kits`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  it("two concurrent identical requests create only one kit/job and start the pipeline once", async () => {
    const [a, b] = await Promise.all([post(BODY, tokenFor("u1")), post(BODY, tokenFor("u1"))]);
    const [ab, bb] = await Promise.all([a.json(), b.json()]);

    // Exactly one logical kit, one job, one pipeline start.
    expect(kits.records).toHaveLength(1);
    expect(jobs.jobs).toHaveLength(1);
    expect(started).toHaveLength(1);

    // Both responses reference the same kit — neither double-created.
    expect(ab.kitId).toBe(bb.kitId);
    expect(ab.kitId).toBe(kits.records[0].id);
  });

  it("different users with identical input remain independent", async () => {
    const [a, b] = await Promise.all([post(BODY, tokenFor("user-a")), post(BODY, tokenFor("user-b"))]);
    const [ab, bb] = await Promise.all([a.json(), b.json()]);

    expect(kits.records).toHaveLength(2);
    expect(jobs.jobs).toHaveLength(2);
    expect(started).toHaveLength(2);
    expect(ab.kitId).not.toBe(bb.kitId);
    // Same normalized hash, but distinct records per user.
    expect(kits.records[0].inputHash).toBe(kits.records[1].inputHash);
  });
});

/**
 * Deterministic conflict path: create ALWAYS reports a duplicate (as if another
 * request committed between our pre-check and create), and the winner's record
 * is already present. Proves the handler fetches and returns it — without
 * creating a second job or starting the pipeline.
 */
describe("POST /kits duplicate-key race returns the existing result", () => {
  let server: Server;
  let base: string;
  let jobs: ReturnType<typeof jobCreator>;
  let started: unknown[];

  beforeEach(async () => {
    jobs = jobCreator();
    started = [];

    const winner: KitRecord = {
      id: "k-winner",
      userId: "u1",
      title: "seed",
      input: BODY,
      inputHash: "seed-hash",
      status: "queued",
      kit: null,
      jobId: "job-winner",
    };

    let created = false;
    const conflictingRepo: KitRepository = {
      // Pre-check misses (winner not visible to this request yet); after a create
      // was attempted, the post-conflict fetch returns the winner.
      async findByUserAndHash(_u, _h) {
        return created ? winner : null;
      },
      async create() {
        created = true;
        throw new KitConflictError();
      },
      async findByIdForUser() {
        return null;
      },
      async setKitForUser() {
        return null;
      },
      async deleteByIdForUser() {
        /* no-op */
      },
      async setJobId() {
        /* no-op */
      },
    };

    const app = createApp({
      authDeps,
      kitDeps: {
        kits: conflictingRepo,
        createJob: jobs.createJob,
        startExecution: (i) => started.push(i),
      },
    });
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  });

  it("returns the winner's kitId/jobId/status and does not re-run the pipeline", async () => {
    const res = await fetch(`${base}/kits`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor("u1")}` },
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kitId).toBe("k-winner");
    expect(body.jobId).toBe("job-winner");
    expect(body.status).toBe("queued");

    // No job created and no pipeline started for the losing request.
    expect(jobs.jobs).toHaveLength(0);
    expect(started).toHaveLength(0);
  });
});
