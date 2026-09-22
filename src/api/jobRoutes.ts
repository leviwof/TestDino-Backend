import {
  Router,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from "express";
import { requireAuth, type AuthedRequest } from "../auth/authMiddleware.js";
import type { AuthDeps } from "../auth/authService.js";
import { getJobById, type JobRecord } from "../services/jobService.js";

/**
 * Job status endpoint.
 *
 *   GET /jobs/:id -> 200 { job }  (404 if missing or owned by another user)
 *
 * Requires a valid JWT. Jobs are owner-scoped by req.user.sub, so a caller can
 * only read their own jobs. The response exposes only client-facing fields
 * (jobId, kitId, status, live progress, optional safe error, timestamps) — never
 * internal fields such as the owning userId, and never stack traces or secrets.
 */

export interface JobRouterDeps {
  /** Injectable job fetch (defaults to the MongoDB-backed jobService). */
  getJob?: (jobId: string) => Promise<JobRecord | null>;
  /** Auth deps for the JWT guard (token verifier / clock). */
  auth?: Pick<AuthDeps, "verifyToken" | "now">;
}

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

function httpError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

/** Client-facing projection of a job (safe fields only). */
function toJobDto(job: JobRecord) {	return {
    jobId: job.jobId,
    kitId: job.kitId,
    status: job.status,
    // Live progress, when the pipeline has reported any: the stage key plus the
    // exact sentence to show the waiting user.
    ...(job.progress?.message
      ? {
          progress: {
            step: job.progress.step,
            message: job.progress.message,
            updatedAt: job.progress.updatedAt,
          },
        }
      : {}),
    // Include the error only when the job actually failed. JobErrorInfo is a
    // curated { code, message } — never a stack trace or raw internal detail.
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function createJobRouter(deps: JobRouterDeps = {}): Router {
  const router = Router();
  const getJob = deps.getJob ?? ((jobId: string) => getJobById(jobId));

  router.use(requireAuth(deps.auth ?? {}));

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const uid = (req as AuthedRequest).user!.sub;
      const job = await getJob(req.params.id);
      // 404 for both "missing" and "belongs to another user" (no existence leak).
      if (!job || job.userId !== uid) {
        throw httpError(404, "not_found", "job not found");
      }
      res.status(200).json({ job: toJobDto(job) });
    }),
  );

  return router;
}
