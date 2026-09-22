import { z } from "zod";
import {
  Difficulty,
  QuestionSchema,
  type CompanyBrief,
  type Question,
  type QuestionCategory,
  type Role,
} from "../schema/kit.js";
import { generateJson, type LlmClient } from "./llmClient.js";

/**
 * Interview question generation, one dedicated LLM call per category:
 *   - generateTechnicalQuestions   -> "technical"
 *   - generateBehaviouralQuestions -> "behavioural"
 *   - generateSystemDesignQuestions-> "system-design"
 *   - generateCompanyFitQuestions  -> "company-fit"
 *
 * All share: Zod validation of the model output, JSON repair (inside
 * generateJson), requirement-id integrity (references must exist; invalid ones
 * are stripped), duplicate removal, and deterministic id assignment. Questions
 * are grounded in the supplied role/requirements; company-fit may use a company
 * brief but must not invent company facts.
 */

export type TechnicalQuestionInput = Role;

export interface CompanyFitInput extends Role {
  /** Company name for context. */
  company?: string;
  /** Optional company brief; used for grounding, never for inventing facts. */
  companyBrief?: CompanyBrief;
}

// Shape we ask the model for (no id/category — we own those). requirement_ids
// may be empty for categories where a question need not map to a JD line.
const LlmQuestionSchema = z.object({
  requirement_ids: z.array(z.coerce.string()),
  prompt: z.string().min(1),
  answer_outline: z.string().min(1),
  difficulty: Difficulty,
});

const LlmQuestionsSchema = z.object({
  questions: z.array(LlmQuestionSchema),
});

export interface GenerateQuestionsDeps {
  /** Injectable LLM client (for tests). Defaults to the env-backed client. */
  client?: Pick<LlmClient, "generateJson">;
}

/** Back-compat alias for the original technical-only deps type. */
export type GenerateTechnicalQuestionsDeps = GenerateQuestionsDeps;

/** Normalise a prompt for duplicate detection. */
function dedupeKey(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Render the requirement list for prompts. */
function renderRequirements(role: Role): string {
  return (
    role.requirements
      .map((r) => `- ${r.id} [${r.kind}/${r.priority}]: ${r.text}`)
      .join("\n") || "(none provided)"
  );
}

/** Render the responsibilities list for prompts. */
function renderResponsibilities(role: Role): string {
  return role.responsibilities.length
    ? role.responsibilities.map((r) => `- ${r}`).join("\n")
    : "(none provided)";
}

const JSON_SHAPE = [
  "Return ONLY a JSON object with this exact shape (no ids, no category):",
  "{",
  '  "questions": [',
  '    { "requirement_ids": string[], "prompt": string, "answer_outline": string, "difficulty": 1|2|3 }',
  "  ]",
  "}",
].join("\n");

/**
 * Run one generation call and post-process the result into validated Questions.
 * `requireRequirementRef` drops questions that reference no existing requirement
 * (used by the technical generator).
 */
async function runGeneration(
  role: Role,
  prompt: string,
  category: QuestionCategory,
  requireRequirementRef: boolean,
  deps: GenerateQuestionsDeps,
): Promise<Question[]> {
  const generate = deps.client
    ? deps.client.generateJson.bind(deps.client)
    : generateJson;

  const raw = await generate<unknown>(prompt);

  // Validate shape (JSON repair already handled inside generateJson).
  const parsed = LlmQuestionsSchema.parse(raw);

  const validReqIds = new Set(role.requirements.map((r) => r.id));
  const seenPrompts = new Set<string>();
  const questions: Question[] = [];

  let counter = 0;
  for (const q of parsed.questions) {
    // Keep only references to requirements that actually exist.
    const refs = [
      ...new Set(
        q.requirement_ids
          .map((id) => (validReqIds.has(id) ? id : validReqIds.has(`r${id}`) ? `r${id}` : undefined))
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    if (requireRequirementRef && refs.length === 0) continue;

    const key = dedupeKey(q.prompt);
    if (seenPrompts.has(key)) continue; // drop obvious duplicates
    seenPrompts.add(key);

    counter += 1;
    questions.push({
      id: `q${counter}`,
      requirement_ids: refs,
      category,
      prompt: q.prompt,
      answer_outline: q.answer_outline,
      difficulty: q.difficulty,
    });
  }

  return questions;
}

// ---- Technical ----

function buildTechnicalPrompt(input: TechnicalQuestionInput): string {
  return [
    `Generate practical TECHNICAL interview questions for the role "${input.title}" (seniority: ${input.seniority || "unspecified"}).`,
    "",
    "STRICT RULES:",
    "- Base every question ONLY on the requirements listed below. Never invent technologies or requirements.",
    "- Each question MUST reference at least one requirement id from the list (by exact id).",
    "- Only technical questions (skills, tools, systems, problem-solving) — no behavioural, system-design, or company-fit questions.",
    "- Provide a concise answer_outline (key points an interviewer would look for).",
    "- difficulty must be 1 (basic), 2 (intermediate), or 3 (advanced), appropriate to the seniority.",
    "- Do not produce duplicate or near-duplicate questions.",
    "",
    "RESPONSIBILITIES (context only):",
    renderResponsibilities(input),
    "",
    "REQUIREMENTS (the only allowed basis for questions):",
    renderRequirements(input),
    "",
    JSON_SHAPE,
  ].join("\n");
}

export async function generateTechnicalQuestions(
  input: TechnicalQuestionInput,
  deps: GenerateQuestionsDeps = {},
): Promise<Question[]> {
  return runGeneration(input, buildTechnicalPrompt(input), "technical", true, deps);
}

// ---- Behavioural ----

function buildBehaviouralPrompt(input: Role): string {
  return [
    `Generate practical BEHAVIOURAL interview questions for the role "${input.title}" (seniority: ${input.seniority || "unspecified"}).`,
    "",
    "STRICT RULES:",
    "- Focus on soft skills, collaboration, ownership, conflict resolution, and past experience.",
    "- Ground questions in the role's responsibilities and requirements. Never invent requirements.",
    "- When a question maps to a requirement, reference that requirement id (by exact id). Only use ids from the list.",
    "- Provide a concise answer_outline (what a strong answer covers, e.g. STAR structure).",
    "- difficulty must be 1, 2, or 3, appropriate to the seniority.",
    "- Do not produce duplicate or near-duplicate questions.",
    "",
    "RESPONSIBILITIES:",
    renderResponsibilities(input),
    "",
    "REQUIREMENTS (reference by id where relevant):",
    renderRequirements(input),
    "",
    JSON_SHAPE,
  ].join("\n");
}

export async function generateBehaviouralQuestions(
  input: Role,
  deps: GenerateQuestionsDeps = {},
): Promise<Question[]> {
  return runGeneration(input, buildBehaviouralPrompt(input), "behavioural", false, deps);
}

// ---- System design ----

function buildSystemDesignPrompt(input: Role): string {
  return [
    `Generate SYSTEM-DESIGN interview questions for the role "${input.title}" (seniority: ${input.seniority || "unspecified"}).`,
    "",
    "STRICT RULES:",
    "- Scope and depth MUST match the seniority: lighter component-level design for junior/mid, broader architecture, scaling, and trade-offs for senior/lead.",
    "- Ground questions in the role's responsibilities and requirements. Never invent technologies or requirements.",
    "- Reference requirement ids (by exact id) where a question builds on a specific requirement. Only use ids from the list.",
    "- Provide a concise answer_outline (key components, trade-offs, and follow-ups an interviewer expects).",
    "- difficulty must be 1, 2, or 3, appropriate to the seniority.",
    "- Do not produce duplicate or near-duplicate questions.",
    "",
    "RESPONSIBILITIES:",
    renderResponsibilities(input),
    "",
    "REQUIREMENTS (reference by id where relevant):",
    renderRequirements(input),
    "",
    JSON_SHAPE,
  ].join("\n");
}

export async function generateSystemDesignQuestions(
  input: Role,
  deps: GenerateQuestionsDeps = {},
): Promise<Question[]> {
  return runGeneration(input, buildSystemDesignPrompt(input), "system-design", false, deps);
}

// ---- Company fit ----

function buildCompanyFitPrompt(input: CompanyFitInput): string {
  const briefBlock = input.companyBrief
    ? [
        `Summary: ${input.companyBrief.summary || "(none)"}`,
        `What they do: ${input.companyBrief.what_they_do || "(none)"}`,
      ].join("\n")
    : "(no company brief provided)";

  return [
    `Generate COMPANY-FIT interview questions for the role "${input.title}"${input.company ? ` at "${input.company}"` : ""} (seniority: ${input.seniority || "unspecified"}).`,
    "",
    "STRICT RULES:",
    "- Focus on motivation, values alignment, and fit with the company/role.",
    "- You MAY use the company brief below for context, but NEVER invent company facts, products, or claims not present in it.",
    "- If the brief is sparse, keep questions general (motivation, working style) rather than fabricating specifics.",
    "- Never invent JD requirements. Reference requirement ids (by exact id) only where relevant, using ids from the list.",
    "- Provide a concise answer_outline (what a strong, genuine answer covers).",
    "- difficulty must be 1, 2, or 3.",
    "- Do not produce duplicate or near-duplicate questions.",
    "",
    "COMPANY BRIEF (context only — do not invent beyond this):",
    briefBlock,
    "",
    "REQUIREMENTS (reference by id where relevant):",
    renderRequirements(input),
    "",
    JSON_SHAPE,
  ].join("\n");
}

export async function generateCompanyFitQuestions(
  input: CompanyFitInput,
  deps: GenerateQuestionsDeps = {},
): Promise<Question[]> {
  return runGeneration(input, buildCompanyFitPrompt(input), "company-fit", false, deps);
}

// ---- Coordinator ----

/** Full input for the coordinator (superset: role + optional company context). */
export type GenerateAllQuestionsInput = CompanyFitInput;

/**
 * Run all four category generators, combine their questions, drop obvious
 * duplicates, and re-assign globally-unique ids. Adds NO new LLM calls of its
 * own — it fans out to the four existing generators (one call each). Each
 * generator already enforces category / difficulty / requirement-id integrity;
 * here we validate every combined question with QuestionSchema as a final guard
 * while preserving the original question objects.
 */
export async function generateAllQuestions(
  input: GenerateAllQuestionsInput,
  deps: GenerateQuestionsDeps = {},
): Promise<Question[]> {
  const [technical, behavioural, systemDesign, companyFit] = await Promise.all([
    generateTechnicalQuestions(input, deps),
    generateBehaviouralQuestions(input, deps),
    generateSystemDesignQuestions(input, deps),
    generateCompanyFitQuestions(input, deps),
  ]);

  const combined = [...technical, ...behavioural, ...systemDesign, ...companyFit];

  const seenPrompts = new Set<string>();
  const questions: Question[] = [];
  let counter = 0;

  for (const q of combined) {
    // Final integrity guard: category / difficulty / requirement_ids shape.
    const valid = QuestionSchema.parse(q);

    const key = dedupeKey(valid.prompt);
    if (seenPrompts.has(key)) continue; // drop cross-category duplicates
    seenPrompts.add(key);

    counter += 1;
    // Preserve the original question object; only re-assign a globally-unique id
    // (per-category ids collide once flattened).
    questions.push({ ...valid, id: `q${counter}` });
  }

  return questions;
}
