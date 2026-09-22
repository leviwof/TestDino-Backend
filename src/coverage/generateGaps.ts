import { z } from "zod";
import { Difficulty, QuestionCategory } from "../schema/kit.js";
import { generateJson, type LlmClient } from "../generation/llmClient.js";
import { checkCoverage } from "./checkCoverage.js";

/**
 * Targeted gap-question generation (a second-pass operation).
 *
 * generateGapQuestions(input) runs the deterministic coverage checker first,
 * finds MUST requirements that no existing question covers, and asks the LLM to
 * generate questions ONLY for those uncovered requirements. Already-covered
 * requirements are never regenerated. The model is given just the relevant
 * uncovered requirements plus the existing questions (so it can avoid
 * duplicates). Output is Zod-validated, JSON repair is handled inside
 * generateJson(), generated questions are filtered to reference at least one
 * uncovered requirement, and duplicates are removed. Returns [] when there are
 * no uncovered must requirements (no LLM call in that case).
 */

export interface GapRequirementInput {
  id: string;
  text: string;
  kind: "technical" | "behavioural" | "domain";
  priority: "must" | "nice";
}

export interface GapExistingQuestion {
  id: string;
  requirement_ids: string[];
  category: "technical" | "behavioural" | "system-design" | "company-fit";
  prompt: string;
  answer_outline: string;
  difficulty: 1 | 2 | 3;
}

export interface GenerateGapQuestionsInput {
  requirements: GapRequirementInput[];
  existingQuestions: GapExistingQuestion[];
}

export interface GenerateGapQuestionsDeps {
  /** Injectable LLM client (for tests). Defaults to the env-backed client. */
  client?: Pick<LlmClient, "generateJson">;
}

export type GapQuestion = GapExistingQuestion;

// Shape we ask the model for (no id — we own that).
const LlmGapQuestionSchema = z.object({
  requirement_ids: z.array(z.coerce.string()),
  category: QuestionCategory,
  prompt: z.string().min(1),
  answer_outline: z.string().min(1),
  difficulty: Difficulty,
});

const LlmGapQuestionsSchema = z.object({
  questions: z.array(LlmGapQuestionSchema),
});

/** Normalise a prompt for duplicate detection. */
function dedupeKey(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildPrompt(
  uncovered: GapRequirementInput[],
  existingQuestions: GapExistingQuestion[],
): string {
  const reqLines = uncovered
    .map((r) => `- ${r.id} [${r.kind}/${r.priority}]: ${r.text}`)
    .join("\n");

  // Only the existing prompts are needed to avoid duplicates — keep it lean.
  const existingLines = existingQuestions.length
    ? existingQuestions.map((q) => `- ${q.prompt}`).join("\n")
    : "(none)";

  return [
    "You are filling COVERAGE GAPS in an interview kit.",
    "Generate new interview questions that cover the UNCOVERED requirements listed below.",
    "",
    "STRICT RULES:",
    "- Cover the supplied requirement ids. Every question MUST reference at least one of them (by exact id).",
    "- Do NOT invent requirements or technologies. Use only the requirements listed here.",
    "- Do NOT duplicate or closely paraphrase any of the existing questions listed below.",
    '- "category" must be one of: "technical", "behavioural", "system-design", "company-fit".',
    "- difficulty must be 1 (basic), 2 (intermediate), or 3 (advanced).",
    "- Provide a concise answer_outline (key points an interviewer would look for).",
    "",
    "UNCOVERED REQUIREMENTS (the only allowed basis for these questions):",
    reqLines,
    "",
    "EXISTING QUESTIONS (do not duplicate these):",
    existingLines,
    "",
    "Return ONLY a JSON object with this exact shape (no ids):",
    "{",
    '  "questions": [',
    '    { "requirement_ids": string[], "category": string, "prompt": string, "answer_outline": string, "difficulty": 1|2|3 }',
    "  ]",
    "}",
  ].join("\n");
}

export async function generateGapQuestions(
  input: GenerateGapQuestionsInput,
  deps: GenerateGapQuestionsDeps = {},
): Promise<GapQuestion[]> {
  // 1) Deterministic coverage pass.
  const coverage = checkCoverage({
    requirements: input.requirements.map((r) => ({ id: r.id, priority: r.priority })),
    questions: input.existingQuestions.map((q) => ({
      id: q.id,
      requirement_ids: q.requirement_ids,
    })),
  });

  // 2) Uncovered MUST requirements only.
  const mustUncovered = new Set(coverage.must_uncovered_requirement_ids);
  const uncovered = input.requirements.filter((r) => mustUncovered.has(r.id));

  // 11) Nothing to do -> no LLM call.
  if (uncovered.length === 0) return [];

  const generate = deps.client
    ? deps.client.generateJson.bind(deps.client)
    : generateJson;

  const raw = await generate<unknown>(buildPrompt(uncovered, input.existingQuestions));

  // 8) Validate shape (JSON repair already handled inside generateJson).
  const parsed = LlmGapQuestionsSchema.parse(raw);

  // Continue existing numbering so gap-question ids don't collide with the
  // questions already in the kit.
  const existingNumbers = input.existingQuestions
    .map((q) => /^q(\d+)$/.exec(q.id))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  let counter = existingNumbers.length ? Math.max(...existingNumbers) : 0;

  const targetIds = new Set(uncovered.map((r) => r.id));
  const existingKeys = new Set(input.existingQuestions.map((q) => dedupeKey(q.prompt)));
  const seen = new Set<string>();
  const questions: GapQuestion[] = [];

  for (const q of parsed.questions) {
    // 7) Keep only references to the uncovered requirements we're targeting;
    // every gap question must reference at least one of them.
    const refs = [
      ...new Set(
        q.requirement_ids
          .map((id) => (targetIds.has(id) ? id : targetIds.has(`r${id}`) ? `r${id}` : undefined))
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    if (refs.length === 0) continue;

    const key = dedupeKey(q.prompt);
    if (existingKeys.has(key)) continue; // don't duplicate existing questions
    if (seen.has(key)) continue; // 10) drop duplicates within this batch
    seen.add(key);

    counter += 1;
    questions.push({
      id: `q${counter}`,
      requirement_ids: refs,
      category: q.category,
      prompt: q.prompt,
      answer_outline: q.answer_outline,
      difficulty: q.difficulty,
    });
  }

  return questions;
}
