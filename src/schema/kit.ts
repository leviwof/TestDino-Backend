import { z } from "zod";

/**
 * Interview-prep-kit schemas.
 *
 * Two layers:
 *  - CoreKitSchema:   exactly the generated kit format (written by the batch command).
 *  - StoredKitSchema: core + builder extension fields (origin/edited/pinned/order,
 *                     plus optional research_notes and research_status).
 *
 * `toCoreKit(stored)` strips the extension fields back down to the core shape.
 */

// ---- Enums / scalars ----

export const RequirementKind = z.enum(["technical", "behavioural", "domain"]);
export const RequirementPriority = z.enum(["must", "nice"]);
export const QuestionCategory = z.enum([
  "technical",
  "behavioural",
  "system-design",
  "company-fit",
]);
export const Difficulty = z.union([z.literal(1), z.literal(2), z.literal(3)]);

// ---- Core sub-schemas ----

export const SourceSchema = z.object({
  company: z.string(),
  company_url: z.string(),
  role: z.string(),
  location: z.string(),
  jd_chars: z.number().int(),
  researched_at: z.string(), // ISO string
  pages_used: z.array(z.string()),
});

export const CompanyBriefSchema = z.object({
  summary: z.string(),
  what_they_do: z.string(),
  sources: z.array(z.string()),
});

export const RequirementSchema = z.object({
  id: z.string(),
  text: z.string(),
  kind: RequirementKind,
  priority: RequirementPriority,
});

export const RoleSchema = z.object({
  title: z.string(),
  seniority: z.string(),
  responsibilities: z.array(z.string()),
  requirements: z.array(RequirementSchema),
});

export const QuestionSchema = z.object({
  id: z.string(),
  requirement_ids: z.array(z.string()),
  category: QuestionCategory,
  prompt: z.string(),
  answer_outline: z.string(),
  difficulty: Difficulty,
});

export const FlashcardSchema = z.object({
  id: z.string(),
  front: z.string(),
  back: z.string(),
  requirement_ids: z.array(z.string()),
});

export const ScheduleDaySchema = z.object({
  day: z.number().int(),
  focus: z.string(),
  question_ids: z.array(z.string()),
  minutes: z.number().int(),
});

export const ScheduleSchema = z.object({
  days_available: z.number().int(),
  days: z.array(ScheduleDaySchema),
});

export const CoverageSchema = z.object({
  uncovered_requirement_ids: z.array(z.string()),
  passes: z.number().int(),
});

// ---- Core kit ----

export const CoreKitSchema = z.object({
  source: SourceSchema,
  company_brief: CompanyBriefSchema,
  role: RoleSchema,
  questions: z.array(QuestionSchema),
  flashcards: z.array(FlashcardSchema),
  schedule: ScheduleSchema,
  coverage: CoverageSchema,
});

// ---- Stored (builder) extension ----

export const Origin = z.enum(["generated", "user"]);

const extensionFields = {
  origin: Origin.default("generated"),
  edited: z.boolean().default(false),
  pinned: z.boolean().default(false),
  order: z.number().default(0),
};

export const StoredQuestionSchema = QuestionSchema.extend(extensionFields);
export const StoredFlashcardSchema = FlashcardSchema.extend(extensionFields);

export const ResearchStatusSchema = z.object({
  hiring_page_found: z.boolean(),
  discussion_found: z.boolean(),
  unreachable_sources: z.array(z.string()),
});

export const StoredKitSchema = CoreKitSchema.extend({
  questions: z.array(StoredQuestionSchema),
  flashcards: z.array(StoredFlashcardSchema),
  research_notes: z.array(z.string()).optional(),
  research_status: ResearchStatusSchema.optional(),
});

// ---- Inferred types ----

export type RequirementKind = z.infer<typeof RequirementKind>;
export type RequirementPriority = z.infer<typeof RequirementPriority>;
export type QuestionCategory = z.infer<typeof QuestionCategory>;
export type Difficulty = z.infer<typeof Difficulty>;

export type Source = z.infer<typeof SourceSchema>;
export type CompanyBrief = z.infer<typeof CompanyBriefSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type Flashcard = z.infer<typeof FlashcardSchema>;
export type ScheduleDay = z.infer<typeof ScheduleDaySchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type Coverage = z.infer<typeof CoverageSchema>;
export type CoreKit = z.infer<typeof CoreKitSchema>;

export type Origin = z.infer<typeof Origin>;
export type StoredQuestion = z.infer<typeof StoredQuestionSchema>;
export type StoredFlashcard = z.infer<typeof StoredFlashcardSchema>;
export type ResearchStatus = z.infer<typeof ResearchStatusSchema>;
export type StoredKit = z.infer<typeof StoredKitSchema>;

// ---- Helpers ----

/**
 * Strip builder extension fields, returning the core kit shape.
 * (CoreKitSchema.parse drops the extra keys on questions/flashcards and the
 * top-level research_notes / research_status.)
 */
export function toCoreKit(stored: StoredKit): CoreKit {
  return CoreKitSchema.parse(stored);
}
