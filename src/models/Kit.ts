import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const KIT_STATUSES = [
  "queued",
  "crawling",
  "researching",
  "generating",
  "reviewing",
  "scheduling",
  "done",
  "failed",
] as const;

const inputSchema = new Schema(
  {
    jd: { type: String, required: true },
    company_url: { type: String, required: true },
    days: { type: Number, required: true },
  },
  { _id: false },
);

const progressSchema = new Schema(
  {
    step: { type: String, default: "" },
    message: { type: String, default: "" },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const errorSchema = new Schema(
  {
    code: { type: String, required: true },
    message: { type: String, required: true },
  },
  { _id: false },
);

const kitSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: { type: String, required: true },
    input: { type: inputSchema, required: true },
    // Used later for idempotent submit; unique together with userId (index below).
    inputHash: { type: String, required: true, index: true },
    // The async job created for this kit (used for idempotent responses).
    jobId: { type: String, default: null },
    status: { type: String, enum: KIT_STATUSES, default: "queued" },
    progress: { type: progressSchema, default: () => ({}) },
    error: { type: errorSchema, default: null },
    // Validated StoredKit; null until the pipeline finishes.
    kit: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

// Idempotent submit: one kit per (user, inputHash).
kitSchema.index({ userId: 1, inputHash: 1 }, { unique: true });

export type Kit = InferSchemaType<typeof kitSchema>;

export const KitModel: Model<Kit> =
  (mongoose.models.Kit as Model<Kit>) ??
  mongoose.model<Kit>("Kit", kitSchema);
