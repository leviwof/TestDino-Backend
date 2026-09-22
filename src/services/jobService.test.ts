import { describe, it, expect, beforeEach } from "vitest";
import {
  createJob,
  updateJobStatus,
  updateJobProgress,
  getJobById,
  canTransition,
  InvalidJobTransitionError,
  JobNotFoundError,
  type JobRecord,
  type JobRepository,
  type JobServiceDeps,
} from "./jobService.js";

/** In-memory job store so tests never touch MongoDB. */
function memoryJobRepo(): JobRepository & { rows: Map<string, JobRecord> } {
  const rows = new Map<string, JobRecord>();
  return {
    rows,
    async create(rec) {
      const now = new Date();
      const record: JobRecord = { ...rec, error: null, createdAt: now, updatedAt: now };
      rows.set(rec.jobId, record);
      return { ...record };
    },
    async findByJobId(jobId) {
      const r = rows.get(jobId);
      return r ? { ...r } : null;
    },
    async update(jobId, patch) {
      const r = rows.get(jobId);
      if (!r) return null;
      const updated: JobRecord = {
        ...r,
        status: patch.status ?? r.status,
        progress: patch.progress !== undefined ? patch.progress : r.progress,
        error: patch.error !== undefined ? patch.error : r.error,
        updatedAt: new Date(),
      };
      rows.set(jobId, updated);
      return { ...updated };
    },
  };
}

let deps: JobServiceDeps;
let seq: number;

beforeEach(() => {
  seq = 0;
  deps = { jobs: memoryJobRepo(), generateId: () => `job-${++seq}` };
});

describe("createJob", () => {
  it("creates a queued job with ids, no error, and timestamps", async () => {
    const job = await createJob({ userId: "u1", kitId: "k1" }, deps);
    expect(job).toMatchObject({
      jobId: "job-1",
      userId: "u1",
      kitId: "k1",
      status: "queued",
      error: null,
    });
    expect(job.createdAt).toBeInstanceOf(Date);
    expect(job.updatedAt).toBeInstanceOf(Date);
  });

  it("starts a queued job with an initial progress message", async () => {
    const job = await createJob({ userId: "u1", kitId: "k1" }, deps);
    expect(job.progress?.step).toBe("queued");
    expect(job.progress?.message).toBeTruthy();
  });
});

describe("updateJobProgress", () => {
  it("stores the step + message without changing the job status", async () => {
    const { jobId } = await createJob({ userId: "u1", kitId: "k1" }, deps);
    await updateJobStatus(jobId, "crawling", {}, deps);

    const updated = await updateJobProgress(
      jobId,
      { step: "crawl", message: "Crawling the company site…" },
      deps,
    );

    expect(updated?.status).toBe("crawling");
    expect(updated?.progress?.step).toBe("crawl");
    expect(updated?.progress?.message).toBe("Crawling the company site…");
    expect(updated?.progress?.updatedAt).toBeInstanceOf(Date);
  });

  it("returns null (never throws) for a job that has vanished", async () => {
    expect(
      await updateJobProgress("gone", { step: "crawl", message: "x" }, deps),
    ).toBeNull();
  });
});

describe("updateJobStatus — valid transitions", () => {
  it("advances queued -> crawling -> generating -> done", async () => {
    const { jobId } = await createJob({ userId: "u1", kitId: "k1" }, deps);

    expect((await updateJobStatus(jobId, "crawling", {}, deps)).status).toBe("crawling");
    expect((await updateJobStatus(jobId, "generating", {}, deps)).status).toBe("generating");
    const done = await updateJobStatus(jobId, "done", {}, deps);
    expect(done.status).toBe("done");
    expect(done.error).toBeNull();
  });

  it("allows failing from queued, crawling, and generating", async () => {
    for (const path of [["crawling"], ["crawling", "generating"]] as const) {
      const { jobId } = await createJob({ userId: "u1", kitId: "k1" }, deps);
      for (const step of path) await updateJobStatus(jobId, step, {}, deps);
      const failed = await updateJobStatus(jobId, "failed", {}, deps);
      expect(failed.status).toBe("failed");
    }
    // queued -> failed directly.
    const { jobId } = await createJob({ userId: "u1", kitId: "k1" }, deps);
    expect((await updateJobStatus(jobId, "failed", {}, deps)).status).toBe("failed");
  });
});

describe("updateJobStatus — invalid transitions", () => {
  it("rejects skipping states and leaving terminal states", async () => {
    const { jobId } = await createJob({ userId: "u1", kitId: "k1" }, deps);

    // queued -> done is not allowed (must crawl + generate first).
    await expect(updateJobStatus(jobId, "done", {}, deps)).rejects.toBeInstanceOf(
      InvalidJobTransitionError,
    );
    // queued -> generating is not allowed.
    await expect(
      updateJobStatus(jobId, "generating", {}, deps),
    ).rejects.toBeInstanceOf(InvalidJobTransitionError);

    // Reach a terminal state, then attempt to leave it.
    await updateJobStatus(jobId, "failed", {}, deps);
    await expect(updateJobStatus(jobId, "crawling", {}, deps)).rejects.toBeInstanceOf(
      InvalidJobTransitionError,
    );
  });

  it("throws JobNotFoundError for an unknown job", async () => {
    await expect(updateJobStatus("nope", "crawling", {}, deps)).rejects.toBeInstanceOf(
      JobNotFoundError,
    );
  });

  it("canTransition reflects the rules", () => {
    expect(canTransition("queued", "crawling")).toBe(true);
    expect(canTransition("generating", "done")).toBe(true);
    expect(canTransition("queued", "done")).toBe(false);
    expect(canTransition("done", "failed")).toBe(false);
  });
});

describe("failed job with error", () => {
  it("records the supplied error when moving to failed", async () => {
    const { jobId } = await createJob({ userId: "u1", kitId: "k1" }, deps);
    await updateJobStatus(jobId, "crawling", {}, deps);

    const failed = await updateJobStatus(
      jobId,
      "failed",
      { error: { code: "crawl_timeout", message: "site did not respond" } },
      deps,
    );
    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({ code: "crawl_timeout", message: "site did not respond" });
  });

  it("applies a default error when none is supplied", async () => {
    const { jobId } = await createJob({ userId: "u1", kitId: "k1" }, deps);
    const failed = await updateJobStatus(jobId, "failed", {}, deps);
    expect(failed.error).toEqual({ code: "job_failed", message: "Job failed" });
  });
});

describe("getJobById", () => {
  it("returns the stored job", async () => {
    const created = await createJob({ userId: "u1", kitId: "k1" }, deps);
    const fetched = await getJobById(created.jobId, deps);
    expect(fetched).toMatchObject({ jobId: created.jobId, status: "queued" });
  });

  it("returns null for a missing job", async () => {
    expect(await getJobById("does-not-exist", deps)).toBeNull();
  });
});
