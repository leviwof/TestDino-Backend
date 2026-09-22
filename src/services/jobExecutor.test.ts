import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { executeJob, type JobExecutorDeps } from "./jobExecutor.js";
import { createApp } from "../app.js";
import { signJwt, verifyJwt } from "../auth/jwt.js";
import type { AuthDeps } from "../auth/authService.js";
import type { KitRecord, KitRepository } from "../api/kitRoutes.js";
import type { CoreKit } from "../schema/kit.js";
import {
  PIPELINE_STAGES,
  type PipelineStageProgress,
  type RunPipelineInput,
} from "../pipeline/runPipeline.js";

/** Records the status transitions the executor performs. */
function recorder() {
  const calls: Array<{ status: string; error?: unknown }> = [];
  const setStatus: JobExecutorDeps["setStatus"] = async (_jobId, status, opts) => {
    calls.push({ status, error: opts?.error });
  };
  return { calls, setStatus, statuses: () => calls.map((c) => c.status) };
}

/** Records the progress pings the executor stores. */
function progressRecorder() {
  const progress: Array<{ step: string; message: string }> = [];
  const setProgress: JobExecutorDeps["setProgress"] = async (_jobId, p) => {
    progress.push(p);
  };
  return { progress, setProgress };
}

const CRAWL_STAGE = PIPELINE_STAGES[0];
const GENERATING_STAGE = PIPELINE_STAGES.find((s) => s.status === "generating")!;

const INPUT: RunPipelineInput = { jd: "x", company_url: "https://x.example.com", days: 3 };

describe("executeJob", () => {
  it("starts the pipeline for a queued job (crawling, then invokes the pipeline)", async () => {
    const rec = recorder();
    let receivedInput: RunPipelineInput | undefined;

    await executeJob(
      { jobId: "j1", kitId: "k1", userId: "u1" },
      {
        loadKitInput: async () => INPUT,
        runKitPipeline: async (input, hooks) => {
          receivedInput = input;
          await hooks.onStage(CRAWL_STAGE);
          return {} as CoreKit;
        },
        setStatus: rec.setStatus,
      },
    );

    expect(receivedInput).toEqual(INPUT);
    expect(rec.statuses()[0]).toBe("crawling");
  });

  it("ends a successful pipeline with done (crawling -> generating -> done)", async () => {
    const rec = recorder();
    await executeJob(
      { jobId: "j1", kitId: "k1", userId: "u1" },
      {
        loadKitInput: async () => INPUT,
        runKitPipeline: async (_i, hooks) => {
          await hooks.onStage(CRAWL_STAGE);
          await hooks.onStage(GENERATING_STAGE);
          return {} as CoreKit;
        },
        setStatus: rec.setStatus,
      },
    );
    expect(rec.statuses()).toEqual(["crawling", "generating", "done"]);
  });

  it("stores each pipeline stage's own message, without repeating a status write", async () => {
    const rec = recorder();
    const prog = progressRecorder();
    const stages: PipelineStageProgress[] = [
      PIPELINE_STAGES[0],
      PIPELINE_STAGES[1],
      GENERATING_STAGE,
    ];

    await executeJob(
      { jobId: "j1", kitId: "k1", userId: "u1" },
      {
        loadKitInput: async () => INPUT,
        runKitPipeline: async (_i, hooks) => {
          for (const s of stages) await hooks.onStage(s);
          return {} as CoreKit;
        },
        setStatus: rec.setStatus,
        setProgress: prog.setProgress,
      },
    );

    // Three stages, but only two status transitions (crawling, generating).
    expect(rec.statuses()).toEqual(["crawling", "generating", "done"]);
    expect(prog.progress).toEqual([
      ...stages.map((s) => ({ step: s.step, message: s.message })),
      { step: "done", message: "Your kit is ready." },
    ]);
  });

  it("never fails a run when recording progress throws", async () => {
    const rec = recorder();
    await executeJob(
      { jobId: "j1", kitId: "k1", userId: "u1" },
      {
        loadKitInput: async () => INPUT,
        runKitPipeline: async (_i, hooks) => {
          await hooks.onStage(CRAWL_STAGE);
          return {} as CoreKit;
        },
        setStatus: rec.setStatus,
        setProgress: async () => {
          throw new Error("progress store down");
        },
      },
    );
    expect(rec.statuses()).toEqual(["crawling", "done"]);
  });

  it("ends a failing pipeline with failed and a safe error (no leak)", async () => {
    const rec = recorder();
    await executeJob(
      { jobId: "j1", kitId: "k1", userId: "u1" },
      {
        loadKitInput: async () => INPUT,
        runKitPipeline: async (_i, hooks) => {
          await hooks.onStage(CRAWL_STAGE);
          throw new Error("SECRET internal detail sk-live-XYZ");
        },
        setStatus: rec.setStatus,
      },
    );

    expect(rec.statuses()).toEqual(["crawling", "failed"]);
    const failed = rec.calls.at(-1)!;
    expect(failed.error).toEqual({
      code: "pipeline_failed",
      message: "Interview kit generation failed",
    });
    // Internal detail must never appear in the recorded job error.
    expect(JSON.stringify(rec.calls)).not.toContain("SECRET internal detail");
  });

  it("does not reject even when loading the kit input fails", async () => {
    const rec = recorder();
    await expect(
      executeJob(
        { jobId: "j1", kitId: "missing", userId: "u1" },
        {
          loadKitInput: async () => null,
          runKitPipeline: async () => ({} as CoreKit),
          setStatus: rec.setStatus,
        },
      ),
    ).resolves.toBeUndefined();
    expect(rec.statuses()).toContain("failed");
  });
});

// ---- POST /kits does not wait for the pipeline ----

const SECRET = "job-exec-test-secret";
const authDeps: AuthDeps = {
  signToken: (claims, opts) => signJwt(claims, { ...opts, secret: SECRET }),
  verifyToken: (token, opts) => verifyJwt(token, { ...opts, secret: SECRET }),
};
const tokenFor = (sub: string) => signJwt({ sub, email: `${sub}@x.com` }, { secret: SECRET });

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
    async setKitForUser() {
      return null;
    },
    async deleteByIdForUser() {
      // no-op
    },
  };
}

describe("POST /kits returns before pipeline completion", () => {
  let server: Server;
  let base: string;

  it("responds 201 while the background pipeline is still running", async () => {
    const kits = memoryKitRepo();
    const rec = recorder();

    // A pipeline that blocks until we resolve it.
    let resolvePipeline!: (kit: CoreKit) => void;
    const pipeline = new Promise<CoreKit>((r) => (resolvePipeline = r));
    let started = false;

    const startExecution = (input: { jobId: string; kitId: string; userId: string }) => {
      void executeJob(input, {
        loadKitInput: async () => INPUT,
        runKitPipeline: async (_i, hooks) => {
          started = true;
          await hooks.onStage(GENERATING_STAGE);
          return pipeline; // stays pending until resolvePipeline is called
        },
        setStatus: rec.setStatus,
      });
    };

    const app = createApp({
      authDeps,
      kitDeps: {
        kits,
        createJob: async (i) => ({ jobId: `job-${i.kitId}`, status: "queued" as const }),
        startExecution,
      },
    });
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const res = await fetch(`${base}/kits`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor("u1")}` },
      body: JSON.stringify(INPUT),
    });

    // POST returned immediately, before the pipeline finished.
    expect(res.status).toBe(201);
    // Let the background microtasks (crawling/generating) settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(true);
    expect(rec.statuses()).not.toContain("done"); // pipeline still pending

    // Now let the pipeline finish and confirm it reaches done.
    resolvePipeline({} as CoreKit);
    await new Promise((r) => setTimeout(r, 10));
    expect(rec.statuses()).toContain("done");

    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  });
});
