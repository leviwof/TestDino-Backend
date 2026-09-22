import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp } from "../app.js";
import { signJwt, verifyJwt } from "../auth/jwt.js";
import type { AuthDeps } from "../auth/authService.js";
import type { JobRecord } from "../services/jobService.js";

const SECRET = "job-route-test-secret";

const authDeps: AuthDeps = {
  signToken: (claims, opts) => signJwt(claims, { ...opts, secret: SECRET }),
  verifyToken: (token, opts) => verifyJwt(token, { ...opts, secret: SECRET }),
};
const tokenFor = (sub: string) => signJwt({ sub, email: `${sub}@x.com` }, { secret: SECRET });

/** In-memory job store keyed by jobId. */
function jobStore(seed: JobRecord[] = []) {
  const rows = new Map(seed.map((j) => [j.jobId, j]));
  return {
    rows,
    getJob: async (jobId: string) => rows.get(jobId) ?? null,
  };
}

function makeJob(over: Partial<JobRecord> = {}): JobRecord {
  const now = new Date("2026-02-01T00:00:00.000Z");
  return {
    jobId: "job-1",
    userId: "owner-1",
    kitId: "kit-1",
    status: "queued",
    error: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe("GET /jobs/:id", () => {
  let server: Server;
  let base: string;

  const start = async (store: ReturnType<typeof jobStore>) => {
    const app = createApp({ authDeps, jobDeps: { getJob: store.getJob } });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  };

  afterEach(async () => {
    if (server) await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  });

  const get = (path: string, token?: string) =>
    fetch(`${base}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  it("lets the authenticated owner fetch their job with the expected fields", async () => {
    await start(jobStore([makeJob()]));

    const res = await get("/jobs/job-1", tokenFor("owner-1"));
    expect(res.status).toBe(200);

    const { job } = await res.json();
    expect(job).toEqual({
      jobId: "job-1",
      kitId: "kit-1",
      status: "queued",
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    // Internal owner id is never exposed.
    expect(job.userId).toBeUndefined();
  });

  it("returns 401 for an unauthenticated request", async () => {
    await start(jobStore([makeJob()]));
    const res = await get("/jobs/job-1");
    expect(res.status).toBe(401);
  });

  it("returns 404 when the job belongs to another user", async () => {
    await start(jobStore([makeJob({ userId: "owner-1" })]));
    const res = await get("/jobs/job-1", tokenFor("intruder"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("returns 404 for a missing job", async () => {
    await start(jobStore([]));
    const res = await get("/jobs/nope", tokenFor("owner-1"));
    expect(res.status).toBe(404);
  });

  it("exposes live progress (step + message) while the job is running", async () => {
    await start(
      jobStore([
        makeJob({
          status: "generating",
          progress: {
            step: "questions",
            message: "Drafting interview questions and answer outlines…",
            updatedAt: new Date("2026-02-01T00:02:00.000Z"),
          },
        }),
      ]),
    );

    const { job } = await (await get("/jobs/job-1", tokenFor("owner-1"))).json();
    expect(job.progress).toEqual({
      step: "questions",
      message: "Drafting interview questions and answer outlines…",
      updatedAt: "2026-02-01T00:02:00.000Z",
    });
  });

  it("omits progress entirely when none was ever recorded", async () => {
    await start(jobStore([makeJob({ progress: null })]));
    const { job } = await (await get("/jobs/job-1", tokenFor("owner-1"))).json();
    expect(job).not.toHaveProperty("progress");
  });

  it("returns the safe error for a failed job", async () => {
    await start(
      jobStore([
        makeJob({
          status: "failed",
          error: { code: "crawl_timeout", message: "site did not respond" },
        }),
      ]),
    );

    const res = await get("/jobs/job-1", tokenFor("owner-1"));
    expect(res.status).toBe(200);
    const { job } = await res.json();
    expect(job.status).toBe("failed");
    expect(job.error).toEqual({ code: "crawl_timeout", message: "site did not respond" });
  });
});
