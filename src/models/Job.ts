import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Async generation job for an interview kit. Tracks the lifecycle of a single
 * kit-generation run, separate from the KitModel document it produces.
 */

export const JOB_STATUSES = [
  "queued",
  "crawling",
  "generating",
  "done",
  "failed",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

const jobErrorSchema = new Schema(
  {
    code: { type: String, required: true },
    message: { type: String, required: true },
  },
  { _id: false },
);

// Live progress reported by the pipeline while the job runs. `step` is the
// machine-readable stage key; `message` is the user-facing sentence clients
// display verbatim. Mirrors the shape already used on KitModel.
const jobProgressSchema = new Schema(
  {
    step: { type: String, default: "" },
    message: { type: String, default: "" },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const jobSchema = new Schema(
  {
    // Public, stable job identifier (separate from the Mongo _id).
    jobId: { type: String, required: true, unique: true, index: true },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    kitId: {
      type: Schema.Types.ObjectId,
      ref: "Kit",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: JOB_STATUSES,
      default: "queued",
      required: true,
    },
    // Latest pipeline progress ping (step + human-readable message).
    progress: { type: jobProgressSchema, default: () => ({}) },
    // Populated only when status is "failed".
    error: { type: jobErrorSchema, default: null },
  },
  { timestamps: true }, // adds createdAt / updatedAt
);

export type Job = InferSchemaType<typeof jobSchema>;

export const JobModel: Model<Job> =
  (mongoose.models.Job as Model<Job>) ?? mongoose.model<Job>("Job", jobSchema);
