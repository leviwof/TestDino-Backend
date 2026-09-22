import {
  Router,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from "express";
import { z } from "zod";
import { createHash } from "node:crypto";
import { KitModel } from "../models/Kit.js";
import { requireAuth, type AuthedRequest } from "../auth/authMiddleware.js";
import type { AuthDeps } from "../auth/authService.js";
import {
  type StoredKit,
  type StoredQuestion,
  QuestionCategory,
  Difficulty,
} from "../schema/kit.js";
import { regenerateKit } from "../services/kitRegeneration.js";
import { createJob as createJobService } from "../services/jobService.js";
import type { JobStatus } from "../models/Job.js";
import { startKitJob, type JobExecutionInput } from "../services/jobExecutor.js";
import {
  sortForPractice,
  defaultIsSeen,
  defaultGetConfidence,
} from "../practice/practiceSorting.js";

/**
 * Interview-kit HTTP API. Every route requires a valid JWT; the authenticated
 * user's id (req.user.sub) is the owner for all reads and writes, so a user can
 * only see and mutate their own kits.
 *
 *   POST /kits                -> 201 { kitId, jobId, status, kit }  create + queue job
 *   GET  /kits/:id            -> 200 { kit }   (404 if missing / owned by another)
 *   POST /kits/:id/regenerate -> 200 { kit }   re-generate, preserving edits/pins
 *   PATCH /kits/:id/questions/:questionId     -> 200 { question } update question
 *   PATCH /kits/:id/questions/:questionId/pin -> 200 { question } pin/unpin question
 *   POST /kits/:id/questions                  -> 201 { question } add user question
 *
 * POST /kits creates the kit record and an async Job in status "queued", then
 * returns immediately — it does NOT run the crawler/LLM pipeline or start any
 * worker. Regeneration delegates to the thin kitRegeneration service.
 */

/** Minimal job info returned to the client for tracking. */
export interface JobInfo {
  jobId: string;
  status: JobStatus;
}

const CreateKitBody = z.object({
  jd: z.string().min(1),
  company_url: z.string().url(),
  days: z.coerce.number().int().positive(),
  title: z.string().min(1).optional(),
});

/** Batch submit: a list of description-and-company pairs (capped to keep one
 *  request bounded). Each item is validated exactly like a single create. */
const BatchCreateBody = z.object({
  items: z.array(CreateKitBody).min(1).max(25),
});

/** Regenerate one named section, or the whole kit when `section` is omitted. */
const RegenerateBody = z.object({
  section: z
    .enum(["company_brief", "role", "questions", "flashcards", "schedule", "coverage"])
    .optional(),
});

const UpdateQuestionBody = z.object({
  prompt: z.string().min(1).optional(),
  answer_outline: z.string().optional(),
  category: QuestionCategory.optional(),
  section: QuestionCategory.optional(),
  difficulty: Difficulty.optional(),
  requirement_ids: z.array(z.string()).optional(),
  pinned: z.boolean().optional(),
  order: z.number().int().optional(),
});

const PinQuestionBody = z.object({
  pinned: z.boolean().optional(),
});

const AddQuestionBody = z.object({
  id: z.string().min(1).optional(),
  prompt: z.string().min(1),
  answer_outline: z.string().default(""),
  category: QuestionCategory.optional(),
  section: QuestionCategory.optional(),
  difficulty: Difficulty.default(2),
  requirement_ids: z.array(z.string()).default([]),
  pinned: z.boolean().default(false),
  order: z.number().int().optional(),
});

const PracticeParamsSchema = z.object({
  id: z.string().min(1),
});

const PracticeQuerySchema = z.object({
  type: z.enum(["all", "questions", "flashcards"]).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export const PracticeItemDtoSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["question", "flashcard"]),
  content: z.string(),
  prompt: z.string().optional(),
  answer_outline: z.string().optional(),
  front: z.string().optional(),
  back: z.string().optional(),
  difficulty: z.number().int(),
  confidence: z.number().nullable().optional(),
  seen: z.boolean(),
  seen_status: z.union([z.boolean(), z.string()]).optional(),
  is_seen: z.boolean().optional(),
  section: z.string(),
  category: z.string().optional(),
  requirement_ids: z.array(z.string()).default([]),
  pinned: z.boolean().optional(),
  origin: z.string().optional(),
  edited: z.boolean().optional(),
  order: z.number().optional(),
});

export type PracticeItemDto = z.infer<typeof PracticeItemDtoSchema>;

export interface KitInput {
  jd: string;
  company_url: string;
  days: number;
}

export interface KitRecord {
  id: string;
  userId: string;
  title: string;
  input: KitInput;
  inputHash: string;
  status: string;
  /** The stored (builder) kit content; null until generation has run. */
  kit?: StoredKit | null;
  /** The async job created for this kit (for idempotent responses). */
  jobId?: string | null;
}

/** Persistence port so routes can be unit-tested without MongoDB. */
export interface KitRepository {
  create(rec: {
    userId: string;
    title: string;
    input: KitInput;
    inputHash: string;
  }): Promise<KitRecord>;
  findByUserAndHash(userId: string, inputHash: string): Promise<KitRecord | null>;
  findByIdForUser(id: string, userId: string): Promise<KitRecord | null>;
  /** List all kits owned by a user, newest first. Optional (defaults to []). */
  listByUser?(userId: string): Promise<KitRecord[]>;
  setKitForUser(
    id: string,
    userId: string,
    kit: StoredKit,
  ): Promise<KitRecord | null>;
  /** Delete a kit (used to roll back when job creation fails). */
  deleteByIdForUser(id: string, userId: string): Promise<void>;
  /** Record the async job id on the kit (for idempotent responses). Optional. */
  setJobId?(id: string, userId: string, jobId: string): Promise<void>;
}

export interface KitRouterDeps {
  /** Injectable kit store (defaults to a MongoDB-backed repository). */
  kits?: KitRepository;
  /** Auth deps for the JWT guard (token verifier / clock). */
  auth?: Pick<AuthDeps, "verifyToken" | "now">;
  /**
   * Injectable regeneration service. Defaults to the thin kitRegeneration
   * service; production wires its generation seam separately.
   */
  regenerate?: (kit: StoredKit) => Promise<StoredKit>;
  /**
   * Injectable async-job creator. Defaults to the jobService (MongoDB-backed).
   * Called after a kit is created to enqueue its generation job.
   */
  createJob?: (input: { userId: string; kitId: string }) => Promise<JobInfo>;
  /**
   * Injectable fire-and-forget starter for the background pipeline execution.
   * Defaults to startKitJob. POST /kits calls this without awaiting it.
   */
  startExecution?: (input: JobExecutionInput) => void;
  /**
   * Best-effort hook invoked when regeneration FAILS, so the associated job can
   * be marked appropriately. The existing kit is always preserved regardless.
   * Defaults to a no-op.
   */
  markRegenerationFailed?: (input: {
    kitId: string;
    userId: string;
    jobId?: string | null;
  }) => Promise<void> | void;
}

// ---- helpers ----

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

/**
 * Raised by a KitRepository.create when the (userId, idempotencyHash) uniqueness
 * constraint is violated — i.e. a concurrent request already created the kit.
 * The route handler catches this and returns the existing record instead.
 */
export class KitConflictError extends Error {
  readonly code = "kit_conflict";
  constructor() {
    super("a kit with the same idempotency key already exists");
    this.name = "KitConflictError";
  }
}

/** True for a MongoDB duplicate-key error (E11000). */
export function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

// ---- idempotency ----

/** Collapse all whitespace runs to single spaces and trim the ends. */
export function normalizeJd(jd: string): string {
  return jd.trim().replace(/\s+/g, " ");
}

/**
 * Canonicalize a company URL so trivially-equivalent forms hash identically:
 * lowercased scheme + host, `www.` and default ports dropped, trailing slashes
 * and fragments removed. Query string is preserved (it can be significant).
 * Falls back to a trimmed/lowercased string if the URL cannot be parsed.
 */
export function normalizeCompanyUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    const protocol = u.protocol.toLowerCase();
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const isDefaultPort =
      (protocol === "https:" && u.port === "443") ||
      (protocol === "http:" && u.port === "80");
    const port = u.port && !isDefaultPort ? `:${u.port}` : "";
    const path = u.pathname.replace(/\/+$/, ""); // strip trailing slash(es)
    return `${protocol}//${host}${port}${path}${u.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Deterministic idempotency hash over the normalized (jd, company_url, days).
 * Whitespace-only and URL-equivalent differences collapse to the same hash;
 * a different `days` produces a different hash.
 */
export function idempotencyHash(input: KitInput): string {
  const canonical = JSON.stringify({
    jd: normalizeJd(input.jd),
    company_url: normalizeCompanyUrl(input.company_url),
    days: input.days,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Public projection of a kit (no internal fields beyond what a client needs). */
function toDto(kit: KitRecord) {
  return {
    id: kit.id,
    title: kit.title,
    input: kit.input,
    status: kit.kit ? "done" : kit.status,
    ...(kit.kit ? {
      company_brief: kit.kit.company_brief,
      role: kit.kit.role,
      questions: kit.kit.questions,
      flashcards: kit.kit.flashcards,
      schedule: kit.kit.schedule,
      coverage: kit.kit.coverage,
      source: kit.kit.source,
    } : {}),
  };
}

/** Lightweight projection for the kits list (no full kit content). */
function toSummaryDto(kit: KitRecord) {
  return {
    id: kit.id,
    title: kit.title,
    input: kit.input,
    status: kit.kit ? "done" : kit.status,
    questionCount: kit.kit?.questions?.length ?? 0,
  };
}

function userId(req: Request): string {
  // requireAuth guarantees req.user is set before these handlers run.
  return (req as AuthedRequest).user!.sub;
}

// ---- default MongoDB-backed repository ----

function mongoKitRepository(): KitRepository {
  const map = (doc: {
    _id: unknown;
    userId: unknown;
    title: string;
    input: KitInput;
    inputHash: string;
    status: string;
    kit?: StoredKit | null;
    jobId?: string | null;
  }): KitRecord => ({
    id: String(doc._id),
    userId: String(doc.userId),
    title: doc.title,
    input: doc.input,
    inputHash: doc.inputHash,
    status: doc.status,
    kit: doc.kit ?? null,
    jobId: doc.jobId ?? null,
  });

  return {
    async create(rec) {
      try {
        const doc = await KitModel.create({
          userId: rec.userId,
          title: rec.title,
          input: rec.input,
          inputHash: rec.inputHash,
          status: "queued",
        });
        return map(doc as never);
      } catch (err) {
        // The unique (userId, inputHash) index rejects a concurrent duplicate.
        if (isDuplicateKeyError(err)) throw new KitConflictError();
        throw err;
      }
    },
    async findByUserAndHash(uid, inputHash) {
      const doc = await KitModel.findOne({ userId: uid, inputHash }).lean().exec();
      return doc ? map(doc as never) : null;
    },
    async findByIdForUser(id, uid) {
      const doc = await KitModel.findOne({ _id: id, userId: uid }).lean().exec();
      return doc ? map(doc as never) : null;
    },
    async listByUser(uid) {
      const docs = await KitModel.find({ userId: uid })
        .sort({ createdAt: -1 })
        .lean()
        .exec();
      return docs.map((d) => map(d as never));
    },
    async setKitForUser(id, uid, kit) {
      const doc = await KitModel.findOneAndUpdate(
        { _id: id, userId: uid },
        { $set: { kit } },
        { new: true },
      )
        .lean()
        .exec();
      return doc ? map(doc as never) : null;
    },
    async setJobId(id, uid, jobId) {
      await KitModel.updateOne({ _id: id, userId: uid }, { $set: { jobId } }).exec();
    },
    async deleteByIdForUser(id, uid) {
      await KitModel.deleteOne({ _id: id, userId: uid }).exec();
    },
  };
}

// ---- router ----

export function createKitRouter(deps: KitRouterDeps = {}): Router {
  const router = Router();
  const kits = deps.kits ?? mongoKitRepository();
  const regenerate = deps.regenerate ?? ((kit: StoredKit) => regenerateKit(kit));
  const markRegenerationFailed = deps.markRegenerationFailed ?? (() => {});
  const createJob =
    deps.createJob ??
    (async (input) => {
      const job = await createJobService(input);
      return { jobId: job.jobId, status: job.status };
    });
  const startExecution = deps.startExecution ?? startKitJob;

  // Protect every kit route with the existing JWT guard.
  router.use(requireAuth(deps.auth ?? {}));

  /**
   * Create a single kit and enqueue its generation job (idempotent per user).
   * Shared by POST / and POST /batch. `existed` is true when an identical kit
   * already existed (so batch can report created-vs-duplicate); no second job
   * or pipeline run is started in that case.
   */
  async function createOneKit(
    uid: string,
    input: KitInput,
    title?: string,
  ): Promise<{
    kitId: string;
    jobId?: string;
    status: string;
    kit: ReturnType<typeof toDto>;
    existed: boolean;
  }> {
    // Deterministic idempotency key over the NORMALIZED input, scoped per user.
    const inputHash = idempotencyHash(input);

    const existing = await kits.findByUserAndHash(uid, inputHash);
    if (existing) {
      return {
        kitId: existing.id,
        jobId: existing.jobId ?? undefined,
        status: existing.status,
        kit: toDto(existing),
        existed: true,
      };
    }

    const finalTitle = title ?? `Interview kit — ${hostOf(input.company_url)}`;

    let created: KitRecord;
    try {
      created = await kits.create({ userId: uid, title: finalTitle, input, inputHash });
    } catch (err) {
      // Concurrent duplicate: another identical request won the race.
      if (err instanceof KitConflictError) {
        const winner = await kits.findByUserAndHash(uid, inputHash);
        if (winner) {
          return {
            kitId: winner.id,
            jobId: winner.jobId ?? undefined,
            status: winner.status,
            kit: toDto(winner),
            existed: true,
          };
        }
      }
      throw err;
    }

    // Enqueue an async generation job (status "queued") owned by the caller.
    let job: JobInfo;
    try {
      job = await createJob({ userId: uid, kitId: created.id });
    } catch (err) {
      // Compensating rollback: don't leave a kit with no tracking job.
      await kits.deleteByIdForUser(created.id, uid).catch(() => undefined);
      throw err;
    }

    await kits.setJobId?.(created.id, uid, job.jobId);
    // Kick off the background pipeline; do NOT await it.
    startExecution({ jobId: job.jobId, kitId: created.id, userId: uid });

    return {
      kitId: created.id,
      jobId: job.jobId,
      status: job.status,
      kit: toDto(created),
      existed: false,
    };
  }

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const body = CreateKitBody.parse(req.body);
      const uid = userId(req);
      const input: KitInput = {
        jd: body.jd,
        company_url: body.company_url,
        days: body.days,
      };
      const result = await createOneKit(uid, input, body.title);
      res.status(result.existed ? 200 : 201).json({
        kitId: result.kitId,
        jobId: result.jobId,
        status: result.status,
        kit: result.kit,
      });
    }),
  );

  // Batch create: prepare for several roles at once from a list of pairs.
  router.post(
    "/batch",
    asyncHandler(async (req, res) => {
      const { items } = BatchCreateBody.parse(req.body);
      const uid = userId(req);

      const results: Array<
        | {
            index: number;
            ok: true;
            kitId: string;
            jobId?: string;
            status: string;
            existed: boolean;
            company_url: string;
          }
        | { index: number; ok: false; error: string; message: string; company_url: string }
      > = [];

      // Sequential so a slow/failing item never blocks the rest, and to keep
      // per-user job creation predictable. Each item is isolated.
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const input: KitInput = {
          jd: item.jd,
          company_url: item.company_url,
          days: item.days,
        };
        try {
          const r = await createOneKit(uid, input, item.title);
          results.push({
            index: i,
            ok: true,
            kitId: r.kitId,
            jobId: r.jobId,
            status: r.status,
            existed: r.existed,
            company_url: item.company_url,
          });
        } catch (err) {
          const anyErr = err as { code?: string };
          results.push({
            index: i,
            ok: false,
            error: anyErr.code ?? "error",
            message: "Failed to create this kit.",
            company_url: item.company_url,
          });
        }
      }

      const created = results.filter((r) => r.ok && !r.existed).length;
      const duplicates = results.filter((r) => r.ok && r.existed).length;
      const failed = results.filter((r) => !r.ok).length;

      res.status(201).json({
        total: items.length,
        created,
        duplicates,
        failed,
        results,
      });
    }),
  );

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const uid = userId(req);
      const list = kits.listByUser ? await kits.listByUser(uid) : [];
      res.status(200).json({ kits: list.map(toSummaryDto) });
    }),
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const kit = await kits.findByIdForUser(req.params.id, userId(req));
      if (!kit) throw httpError(404, "not_found", "kit not found");
      res.status(200).json({ kit: toDto(kit) });
    }),
  );

  router.get(
    "/:id/practice",
    asyncHandler(async (req, res) => {
      const { id } = PracticeParamsSchema.parse(req.params);
      const query = PracticeQuerySchema.parse(req.query);
      const uid = userId(req);
      const record = await kits.findByIdForUser(id, uid);
      // 404 for missing or unauthorized kits (ownership protection)
      if (!record) throw httpError(404, "not_found", "kit not found");

      const rawQuestions = record.kit?.questions ?? [];
      const rawFlashcards = record.kit?.flashcards ?? [];

      const practiceItems: PracticeItemDto[] = [];

      if (query.type !== "flashcards") {
        for (const q of rawQuestions) {
          const seen = defaultIsSeen(q);
          const confidence = defaultGetConfidence(q) ?? null;
          const section = (q as any).section ?? q.category ?? "technical";
          practiceItems.push({
            id: q.id,
            type: "question",
            prompt: q.prompt,
            answer_outline: q.answer_outline,
            content: q.prompt,
            difficulty: q.difficulty,
            confidence,
            seen,
            seen_status: seen,
            is_seen: seen,
            section,
            category: q.category,
            requirement_ids: q.requirement_ids ?? [],
            pinned: q.pinned ?? false,
            origin: q.origin ?? "generated",
            edited: q.edited ?? false,
            order: q.order ?? 0,
          });
        }
      }

      if (query.type !== "questions") {
        for (const f of rawFlashcards) {
          const seen = defaultIsSeen(f);
          const confidence = defaultGetConfidence(f) ?? null;
          const section = (f as any).section ?? (f as any).category ?? "flashcards";
          practiceItems.push({
            id: f.id,
            type: "flashcard",
            front: f.front,
            back: f.back,
            content: f.front,
            difficulty: (f as any).difficulty ?? 1,
            confidence,
            seen,
            seen_status: seen,
            is_seen: seen,
            section,
            category: (f as any).category ?? "flashcards",
            requirement_ids: f.requirement_ids ?? [],
            pinned: f.pinned ?? false,
            origin: f.origin ?? "generated",
            edited: f.edited ?? false,
            order: f.order ?? 0,
          });
        }
      }

      // Validate all items
      for (const item of practiceItems) {
        PracticeItemDtoSchema.parse(item);
      }

      // Pure confidence-weighted sorting function
      const sorted = sortForPractice(practiceItems);
      const items = query.limit ? sorted.slice(0, query.limit) : sorted;

      res.status(200).json({
        kitId: record.id,
        items,
        practice: items,
        practiceItems: items,
        total: items.length,
      });
    }),
  );

  router.post(
    "/:id/regenerate",
    asyncHandler(async (req, res) => {
      // Optional `section` regenerates just that part of the kit; omitting it
      // regenerates the whole kit (previous behaviour). Either way, edited,
      // user-authored, and pinned questions are preserved by the regenerate seam.
      const { section } = RegenerateBody.parse(req.body ?? {});
      const uid = userId(req);
      const record = await kits.findByIdForUser(req.params.id, uid);
      // 404 for both "missing" and "belongs to another user" (no existence leak).
      if (!record) throw httpError(404, "not_found", "kit not found");
      if (!record.kit) {
        throw httpError(409, "not_generated", "kit has not been generated yet");
      }

      let regenerated: StoredKit;
      try {
        regenerated = await regenerate(record.kit);
      } catch (err) {
        // Regeneration failed. Crucially, we DO NOT write anything back, so the
        // existing valid kit is preserved untouched. Mark the job appropriately
        // (best-effort), then let the centralized handler return a safe error.
        await Promise.resolve(
          markRegenerationFailed({
            kitId: record.id,
            userId: uid,
            jobId: record.jobId ?? null,
          }),
        ).catch(() => undefined);
        throw err;
      }

      // For a single section, keep every other part of the existing kit exactly
      // as it was (edits elsewhere are never lost) and swap in only the fresh
      // section. For a full regenerate, replace the whole content.
      let toSave: StoredKit;
      if (section) {
        toSave = { ...record.kit };
        switch (section) {
          case "company_brief":
            toSave.company_brief = regenerated.company_brief;
            break;
          case "role":
            toSave.role = regenerated.role;
            break;
          case "questions":
            toSave.questions = regenerated.questions;
            break;
          case "flashcards":
            toSave.flashcards = regenerated.flashcards;
            break;
          case "schedule":
            toSave.schedule = regenerated.schedule;
            break;
          case "coverage":
            toSave.coverage = regenerated.coverage;
            break;
        }
      } else {
        toSave = regenerated;
      }

      // Only persist on success (atomic replace of the kit content).
      const updated = await kits.setKitForUser(record.id, uid, toSave);
      res.status(200).json({
        id: record.id,
        section: section ?? null,
        kit: updated?.kit ?? toSave,
      });
    }),
  );

  // ---- Question management endpoints ----

  // Update question
  const handleUpdateQuestion: RequestHandler = asyncHandler(async (req, res) => {
    const body = UpdateQuestionBody.parse(req.body);
    const uid = userId(req);
    const record = await kits.findByIdForUser(req.params.id, uid);
    if (!record) throw httpError(404, "not_found", "kit not found");
    if (!record.kit) {
      throw httpError(409, "not_generated", "kit has not been generated yet");
    }

    const questionIndex = record.kit.questions.findIndex(
      (q) => q.id === req.params.questionId,
    );
    if (questionIndex === -1) {
      throw httpError(404, "question_not_found", "question not found in kit");
    }

    const existing = record.kit.questions[questionIndex];
    // Scope rules:
    // User-created questions must use: origin = user, edited = true
    // Editing a generated question must set: edited = true, origin remains generated
    const origin = existing.origin === "user" ? "user" : "generated";
    const edited = true;
    const category = body.category ?? body.section ?? existing.category;

    const updatedQuestion: StoredQuestion = {
      ...existing,
      ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
      ...(body.answer_outline !== undefined ? { answer_outline: body.answer_outline } : {}),
      category,
      ...(body.difficulty !== undefined ? { difficulty: body.difficulty } : {}),
      ...(body.requirement_ids !== undefined ? { requirement_ids: body.requirement_ids } : {}),
      ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
      ...(body.order !== undefined ? { order: body.order } : {}),
      origin,
      edited,
    };

    record.kit.questions[questionIndex] = updatedQuestion;
    await kits.setKitForUser(record.id, uid, record.kit);

    res.status(200).json({ question: updatedQuestion });
  });

  router.patch("/:id/questions/:questionId", handleUpdateQuestion);
  router.put("/:id/questions/:questionId", handleUpdateQuestion);

  // Pin / unpin question
  const handlePinQuestion: RequestHandler = asyncHandler(async (req, res) => {
    const body = PinQuestionBody.parse(req.body ?? {});
    const uid = userId(req);
    const record = await kits.findByIdForUser(req.params.id, uid);
    if (!record) throw httpError(404, "not_found", "kit not found");
    if (!record.kit) {
      throw httpError(409, "not_generated", "kit has not been generated yet");
    }

    const questionIndex = record.kit.questions.findIndex(
      (q) => q.id === req.params.questionId,
    );
    if (questionIndex === -1) {
      throw httpError(404, "question_not_found", "question not found in kit");
    }

    const existing = record.kit.questions[questionIndex];
    const pinned = body.pinned !== undefined ? body.pinned : !existing.pinned;

    const updatedQuestion: StoredQuestion = {
      ...existing,
      pinned,
    };

    record.kit.questions[questionIndex] = updatedQuestion;
    await kits.setKitForUser(record.id, uid, record.kit);

    res.status(200).json({ question: updatedQuestion });
  });

  router.patch("/:id/questions/:questionId/pin", handlePinQuestion);
  router.post("/:id/questions/:questionId/pin", handlePinQuestion);
  router.put("/:id/questions/:questionId/pin", handlePinQuestion);

  // Add user question
  router.post(
    "/:id/questions",
    asyncHandler(async (req, res) => {
      const body = AddQuestionBody.parse(req.body);
      const uid = userId(req);
      const record = await kits.findByIdForUser(req.params.id, uid);
      if (!record) throw httpError(404, "not_found", "kit not found");
      if (!record.kit) {
        throw httpError(409, "not_generated", "kit has not been generated yet");
      }

      const category = body.category ?? body.section ?? "technical";
      const id =
        body.id ||
        `user-q-${createHash("sha256")
          .update(`${record.id}:${Date.now()}:${Math.random()}`)
          .digest("hex")
          .slice(0, 10)}`;

      // User-created questions must use: origin = user, edited = true
      const newQuestion: StoredQuestion = {
        id,
        prompt: body.prompt,
        answer_outline: body.answer_outline,
        category,
        difficulty: body.difficulty,
        requirement_ids: body.requirement_ids,
        origin: "user",
        edited: true,
        pinned: body.pinned ?? false,
        order: body.order !== undefined ? body.order : record.kit.questions.length,
      };

      record.kit.questions.push(newQuestion);
      await kits.setKitForUser(record.id, uid, record.kit);

      res.status(201).json({ question: newQuestion });
    }),
  );

  // Delete a question from the kit.
  router.delete(
    "/:id/questions/:questionId",
    asyncHandler(async (req, res) => {
      const uid = userId(req);
      const record = await kits.findByIdForUser(req.params.id, uid);
      if (!record) throw httpError(404, "not_found", "kit not found");
      if (!record.kit) {
        throw httpError(409, "not_generated", "kit has not been generated yet");
      }

      const idx = record.kit.questions.findIndex(
        (q) => q.id === req.params.questionId,
      );
      if (idx === -1) {
        throw httpError(404, "question_not_found", "question not found in kit");
      }

      record.kit.questions.splice(idx, 1);
      await kits.setKitForUser(record.id, uid, record.kit);
      res.status(200).json({ ok: true, id: req.params.questionId });
    }),
  );

  // Reorder questions. Distinct top-level path (/:id/reorder) so it can't be
  // mistaken for /:id/questions/:questionId. Reordering never marks a question
  // as edited — it only rewrites the `order` field.
  const ReorderBody = z.object({ order: z.array(z.string()).min(1) });
  const handleReorder: RequestHandler = asyncHandler(async (req, res) => {
    const { order } = ReorderBody.parse(req.body);
    const uid = userId(req);
    const record = await kits.findByIdForUser(req.params.id, uid);
    if (!record) throw httpError(404, "not_found", "kit not found");
    if (!record.kit) {
      throw httpError(409, "not_generated", "kit has not been generated yet");
    }

    const rank = new Map(order.map((id, i) => [id, i]));
    // Listed questions take the given order; any not listed keep a stable
    // position after them (their existing order, offset past the listed block).
    const base = order.length;
    record.kit.questions.forEach((q, i) => {
      const r = rank.get(q.id);
      q.order = r !== undefined ? r : base + i;
    });
    record.kit.questions.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    await kits.setKitForUser(record.id, uid, record.kit);
    res.status(200).json({ questions: record.kit.questions });
  });
  router.patch("/:id/reorder", handleReorder);
  router.post("/:id/reorder", handleReorder);

  return router;
}
