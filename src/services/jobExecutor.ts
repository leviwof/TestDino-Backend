import { KitModel } from "../models/Kit.js";
import {
  runPipeline,
  type PipelineStageProgress,
  type RunPipelineInput,
} from "../pipeline/runPipeline.js";
import {
  updateJobProgress,
  updateJobStatus,
  type JobErrorInfo,
} from "./jobService.js";
import type { CoreKit } from "../schema/kit.js";

/**
 * Execution boundary between a queued Job and the existing interview-kit
 * pipeline (Phase 9's runPipeline). This does NOT rewrite any pipeline stage and
 * does NOT introduce a queue/broker — it simply drives job status as the
 * pipeline runs:
 *
 *   queued --(start)--> crawling --(crawl done)--> generating --(ok)--> done
 *                                                              \--(err)--> failed
 *
 * Alongside each status change it records the pipeline's own progress ping
 * (stage key + human sentence), so a waiting user sees what is actually
 * happening rather than a guess.
 *
 * executeJob() is self-contained: it catches its own errors and always resolves,
 * so startJobExecution() can fire it in the background without risking an
 * unhandled promise rejection.
 */

export interface JobExecutionInput {
  jobId: string;
  kitId: string;
  userId: string;
}

/** Runs the pipeline, invoking onGenerating once the crawl phase completes. */
export interface RunKitPipeline {
  (
    input: RunPipelineInput,
    hooks: { onStage: (progress: PipelineStageProgress) => Promise<void> },
  ): Promise<CoreKit>;
}

export interface JobExecutorDeps {
  loadKitInput: (kitId: string, userId: string) => Promise<RunPipelineInput | null>;
  runKitPipeline: RunKitPipeline;
  setStatus: (
    jobId: string,
    status: "crawling" | "generating" | "done" | "failed",
    opts?: { error?: JobErrorInfo },
  ) => Promise<unknown>;
  /** Optional: record the pipeline's live progress message. */
  setProgress?: (
    jobId: string,
    progress: { step: string; message: string },
  ) => Promise<unknown>;
  /** Optional: persist the generated kit content on success. */
  saveKit?: (kitId: string, userId: string, kit: CoreKit) => Promise<unknown>;
  logger?: (message: string, err?: unknown) => void;
}

/**
 * Reduce any thrown value to a safe, non-leaky job error. The real error detail
 * is logged server-side; the stored/returned message is always generic.
 */
export function toSafeJobError(_err: unknown): JobErrorInfo {
  return { code: "pipeline_failed", message: "Interview kit generation failed" };
}

/** Execute a queued job's pipeline, advancing its status. Never rejects. */
export async function executeJob(
  input: JobExecutionInput,
  deps: JobExecutorDeps,
): Promise<void> {
  const { jobId, kitId, userId } = input;
  const log = deps.logger ?? (() => {});

  try {
    const kitInput = await deps.loadKitInput(kitId, userId);
    if (!kitInput) throw new Error(`kit ${kitId} not found for user`);

    // Track the last coarse status we wrote: the job lifecycle only allows
    // queued -> crawling -> generating -> done, so repeated same-status writes
    // would be an invalid transition. Status is driven by the pipeline itself.
    let currentStatus: "crawling" | "generating" | null = null;

    const onStage = async (progress: PipelineStageProgress) => {
      if (progress.status !== currentStatus) {
        await deps.setStatus(jobId, progress.status);
        currentStatus = progress.status;
      }
      if (!deps.setProgress) return;
      try {
        await deps.setProgress(jobId, {
          step: progress.step,
          message: progress.message,
        });
      } catch (err) {
        // Progress is a courtesy: never let it fail the run.
        log("failed to record job progress", err);
      }
    };

    const kit = await deps.runKitPipeline(kitInput, { onStage });

    if (deps.saveKit) await deps.saveKit(kitId, userId, kit);
    await deps.setStatus(jobId, "done");
    try {
      await deps.setProgress?.(jobId, {
        step: "done",
        message: "Your kit is ready.",
      });
    } catch (err) {
      log("failed to record job progress", err);
    }
  } catch (err) {
    log("job execution failed", err);
    try {
      await deps.setStatus(jobId, "failed", { error: toSafeJobError(err) });
    } catch (statusErr) {
      log("failed to mark job as failed", statusErr);
    }
  }
}

/**
 * Fire-and-forget starter (used by POST /kits). Returns immediately; the pipeline
 * runs in the background. Any unexpected rejection is swallowed + logged so it
 * can never become an unhandled rejection.
 */
export function startJobExecution(
  input: JobExecutionInput,
  deps: JobExecutorDeps,
): void {
  void executeJob(input, deps).catch((err) => {
    (deps.logger ?? (() => {}))("unexpected job executor crash", err);
  });
}

// ---- default production wiring ----

/** Build executor deps wired to the real models/pipeline. */
export function defaultJobExecutorDeps(): JobExecutorDeps {
  return {
    async loadKitInput(kitId, userId) {
      const rec = await KitModel.findOne({ _id: kitId, userId }).lean().exec();
      const kitInput = (rec as { input?: RunPipelineInput } | null)?.input;
      if (!kitInput) return null;
      return {
        jd: kitInput.jd,
        company_url: kitInput.company_url,
        days: kitInput.days,
      };
    },
    async runKitPipeline(input, hooks) {
      // The pipeline reports its own stages; no stage behaviour is rewritten.
      return runPipeline(input, { onStage: hooks.onStage });
    },
    setStatus: (jobId, status, opts) => updateJobStatus(jobId, status, opts ?? {}),
    setProgress: (jobId, progress) => updateJobProgress(jobId, progress),
    async saveKit(kitId, userId, kit) {
      await KitModel.updateOne({ _id: kitId, userId }, { $set: { kit, status: "done" } }).exec();
    },
    logger: (message, err) =>
      // eslint-disable-next-line no-console
      console.error(`[jobExecutor] ${message}`, err ?? ""),
  };
}

/** Convenience: start a job's pipeline with the default (real) wiring. */
export function startKitJob(input: JobExecutionInput): void {
  startJobExecution(input, defaultJobExecutorDeps());
}
