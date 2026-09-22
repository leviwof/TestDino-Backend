import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp } from "../app.js";
import { signJwt, verifyJwt } from "../auth/jwt.js";
import type { AuthDeps } from "../auth/authService.js";
import {
  idempotencyHash,
  normalizeCompanyUrl,
  normalizeJd,
  type KitRecord,
  type KitRepository,
} from "./kitRoutes.js";

const SECRET = "kit-idempotency-test-secret";
const authDeps: AuthDeps = {
  signToken: (claims, opts) => signJwt(claims, { ...opts, secret: SECRET }),
  verifyToken: (token, opts) => verifyJwt(token, { ...opts, secret: SECRET }),
};
const tokenFor = (sub: string) => signJwt({ sub, email: `${sub}@x.com` }, { secret: SECRET });

const BASE = {
  jd: "Senior Backend Engineer. TypeScript, Node.js, PostgreSQL.",
  company_url: "https://northwind.example.com",
  days: 5,
};

// ---- pure hash/normalization unit tests ----

describe("idempotency hashing", () => {
  it("collapses whitespace differences to the same hash", () => {
    const a = idempotencyHash({ ...BASE, jd: "  Senior   Backend\n\nEngineer.  " });
    const b = idempotencyHash({ ...BASE, jd: "Senior Backend Engineer." });
    expect(normalizeJd("  Senior   Backend\n\nEngineer.  ")).toBe("Senior Backend Engineer.");
    expect(a).toBe(b);
  });

  it("treats equivalent URLs as the same hash", () => {
    const forms = [
      "https://northwind.example.com",
      "https://northwind.example.com/",
      "https://www.northwind.example.com",
      "https://NORTHWIND.example.com/",
      "https://northwind.example.com:443/",
    ];
    const canonical = normalizeCompanyUrl(BASE.company_url);
    for (const company_url of forms) {
      expect(normalizeCompanyUrl(company_url)).toBe(canonical);
      expect(idempotencyHash({ ...BASE, company_url })).toBe(idempotencyHash(BASE));
    }
  });

  it("produces a different hash when days differ", () => {
    expect(idempotencyHash({ ...BASE, days: 3 })).not.toBe(idempotencyHash({ ...BASE, days: 5 }));
  });
});

// ---- HTTP idempotency behavior ----

function memoryKitRepo(): KitRepository & { records: KitRecord[] } {
  const records: KitRecord[] = [];
  let seq = 0;
  return {
    records,
    async create(rec) {
      const r: KitRecord = { id: `k${++seq}`, status: "queued", kit: null, jobId: null, ...rec };
      records.push(r);
      return r;
    },
    async findByUserAndHash(u, h) {
      return records.find((r) => r.userId === u && r.inputHash === h) ?? null;
    },
    async findByIdForUser(id, u) {
      return records.find((r) => r.id === id && r.userId === u) ?? null;
    },
    async setKitForUser() {
      return null;
    },
    async deleteByIdForUser(id, u) {
      const i = records.findIndex((r) => r.id === id && r.userId === u);
      if (i >= 0) records.splice(i, 1);
    },
    async setJobId(id, u, jobId) {
      const r = records.find((x) => x.id === id && x.userId === u);
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

describe("POST /kits idempotency", () => {
  let server: Server;
  let base: string;
  let kits: ReturnType<typeof memoryKitRepo>;
  let jobs: ReturnType<typeof jobCreator>;
  let started: Array<{ jobId: string; kitId: string; userId: string }>;

  beforeEach(async () => {
    kits = memoryKitRepo();
    jobs = jobCreator();
    started = [];
    const app = createApp({
      authDeps,
      kitDeps: {
        kits,
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

  const post = (body: unknown, token: string) =>
    fetch(`${base}/kits`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  it("returns the existing kit/job for identical normalized input (no new pipeline)", async () => {
    const first = await (await post(BASE, tokenFor("u1"))).json();
    expect(first.kitId).toBeTruthy();
    expect(first.jobId).toBe("job-1");

    // Same input but with whitespace + URL variations -> same kit/job.
    const second = await post(
      { jd: "  Senior   Backend Engineer.\nTypeScript, Node.js, PostgreSQL.  ", company_url: "https://www.northwind.example.com/", days: 5 },
      tokenFor("u1"),
    );
    expect(second.status).toBe(200); // not 201: idempotent hit
    const body = await second.json();
    expect(body.kitId).toBe(first.kitId);
    expect(body.jobId).toBe(first.jobId);

    // Only ONE kit, ONE job, and ONE pipeline start.
    expect(kits.records).toHaveLength(1);
    expect(jobs.jobs).toHaveLength(1);
    expect(started).toHaveLength(1);
  });

  it("lets different users create their own kit for the same input", async () => {
    const a = await (await post(BASE, tokenFor("user-a"))).json();
    const b = await (await post(BASE, tokenFor("user-b"))).json();

    // Distinct kits/jobs; neither is treated as an idempotent hit of the other.
    expect(a.kitId).not.toBe(b.kitId);
    expect(kits.records).toHaveLength(2);
    expect(kits.records[0].userId).toBe("user-a");
    expect(kits.records[1].userId).toBe("user-b");
    // Same normalized hash, but scoped per user.
    expect(kits.records[0].inputHash).toBe(kits.records[1].inputHash);
    expect(started).toHaveLength(2);
  });
});
