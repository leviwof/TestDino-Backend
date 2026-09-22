import { randomUUID } from "node:crypto";
import { JobModel, type JobStatus } from "../models/Job.js";

/**
 * Job foundation service: create a job, advance its status through the allowed
 * lifecycle, and fetch it by id. Persistence is behind an injectable repository
 * so the transition rules can be unit-tested without MongoDB.
 *
 * This does NOT run the LLM pipeline and does NOT start any background worker —
 * it only records and guards job state.
 *
 * Allowed transitions:
 *   queued    -> crawling | failed
 *   crawling  -> generating | failed
 *   generating-> done | failed
 *   done      -> (terminal)
 *   failed    -> (terminal)
 */

export interface JobErrorInfo {
  code: string;
  message: string;
}

/**
 * Live progress for a running job. `step` is the pipeline stage key; `message`
 * is the sentence clients display verbatim.
 */
export interface JobProgress {
  step: string;
  message: string;
  updatedAt: Date;
}

export interface JobRecord {
  jobId: string;
  userId: string;
  kitId: string;
  status: JobStatus;
  progress?: JobProgress | null;
  error: JobErrorInfo | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The message a freshly queued job reports, so the UI never starts empty. */
export const QUEUED_PROGRESS: Omit<JobProgress, "updatedAt"> = {
  step: "queued",
  message: "Request received — starting your kit in a moment…",
};

// ---- typed errors ----

export class JobNotFoundError extends Error {
  readonly code = "job_not_found";
  readonly status = 404;
  constructor(public readonly jobId: string) {
    super(`job not found: ${jobId}`);
    this.name = "JobNotFoundError";
  }
}

export class InvalidJobTransitionError extends Error {
  readonly code = "invalid_transition";
  readonly status = 409;
  constructor(
    public readonly from: JobStatus,
    public readonly to: JobStatus,
  ) {
    super(`invalid job status transition: ${from} -> ${to}`);
    this.name = "InvalidJobTransitionError";
  }
}

// ---- transition rules ----

const VALID_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["crawling", "failed"],
  crawling: ["generating", "failed"],
  generating: ["done", "failed"],
  done: [],
  failed: [],
};

/** True when `to` is a permitted next status from `from`. */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---- persistence port ----

export interface JobRepository {
  create(rec: {
    jobId: string;
    userId: string;
    kitId: string;
    status: JobStatus;
    progress?: Omit<JobProgress, "updatedAt">;
  }): Promise<JobRecord>;
  findByJobId(jobId: string): Promise<JobRecord | null>;
  update(
    jobId: string,
    patch: {
      status?: JobStatus;
      error?: JobErrorInfo | null;
      progress?: JobProgress;
    },
  ): Promise<JobRecord | null>;
}

export interface JobServiceDeps {
  /** Injectable job store (defaults to a MongoDB-backed repository). */
  jobs?: JobRepository;
  /** Injectable id generator (defaults to crypto.randomUUID). */
  generateId?: () => string;
}

/** Default MongoDB-backed repository (used when none is injected). */
function mongoJobRepository(): JobRepository {
  const map = (doc: {
    jobId: string;
    userId: unknown;
    kitId: unknown;
    status: JobStatus;
    progress?: JobProgress | null;
    error?: JobErrorInfo | null;
    createdAt: Date;
    updatedAt: Date;
  }): JobRecord => ({
    jobId: doc.jobId,
    userId: String(doc.userId),
    kitId: String(doc.kitId),
    status: doc.status,
    // Only surface progress once it actually carries a message.
    progress: doc.progress?.message
      ? {
          step: doc.progress.step ?? "",
          message: doc.progress.message,
          updatedAt: doc.progress.updatedAt,
        }
      : null,
    error: doc.error ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });

  return {
    async create(rec) {
      const doc = await JobModel.create({ ...rec, error: null });
      return map(doc as never);
    },
    async findByJobId(jobId) {
      const doc = await JobModel.findOne({ jobId }).lean().exec();
      return doc ? map(doc as never) : null;
    },
    async update(jobId, patch) {
      const doc = await JobModel.findOneAndUpdate(
        { jobId },
        { $set: patch },
        { new: true },
      )
        .lean()
        .exec();
      return doc ? map(doc as never) : null;
    },
  };
}

// ---- operations ----

/** Create a new job in the "queued" state. */
export async function createJob(
  input: { userId: string; kitId: string },
  deps: JobServiceDeps = {},
): Promise<JobRecord> {
  const jobs = deps.jobs ?? mongoJobRepository();
  const jobId = deps.generateId ? deps.generateId() : randomUUID();
  return jobs.create({
    jobId,
    userId: input.userId,
    kitId: input.kitId,
    status: "queued",
    progress: QUEUED_PROGRESS,
  });
}

/**
 * Advance a job to `nextStatus`, enforcing the allowed transitions. When moving
 * to "failed", an error is recorded (a default is used if none is supplied).
 */
export async function updateJobStatus(
  jobId: string,
  nextStatus: JobStatus,
  input: { error?: JobErrorInfo } = {},
  deps: JobServiceDeps = {},
): Promise<JobRecord> {
  const jobs = deps.jobs ?? mongoJobRepository();

  const job = await jobs.findByJobId(jobId);
  if (!job) throw new JobNotFoundError(jobId);

  if (!canTransition(job.status, nextStatus)) {
    throw new InvalidJobTransitionError(job.status, nextStatus);
  }

  const patch: { status: JobStatus; error?: JobErrorInfo | null } = {
    status: nextStatus,
  };
  if (nextStatus === "failed") {
    patch.error = input.error ?? { code: "job_failed", message: "Job failed" };
  }

  const updated = await jobs.update(jobId, patch);
  // The job existed a moment ago; a null here is an unexpected store fault.
  if (!updated) throw new JobNotFoundError(jobId);
  return updated;
}

/**
 * Record live progress for a job without touching its status.
 *
 * Deliberately best-effort: progress is a courtesy to the waiting user, so a
 * vanished job returns null instead of throwing into the middle of a pipeline
 * run. Status changes still go through updateJobStatus and its transition guard.
 */
export async function updateJobProgress(
  jobId: string,
  progress: { step: string; message: string },
  deps: JobServiceDeps = {},
): Promise<JobRecord | null> {
  const jobs = deps.jobs ?? mongoJobRepository();
  return jobs.update(jobId, {
    progress: {
      step: progress.step,
      message: progress.message,
      updatedAt: new Date(),
    },
  });
}

/** Fetch a job by its public id, or null if it does not exist. */
export async function getJobById(
  jobId: string,
  deps: JobServiceDeps = {},
): Promise<JobRecord | null> {
  const jobs = deps.jobs ?? mongoJobRepository();
  return jobs.findByJobId(jobId);
}
