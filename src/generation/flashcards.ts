import { z } from "zod";
import { type Flashcard } from "../schema/kit.js";
import { generateJson, type LlmClient } from "./llmClient.js";

/**
 * Flashcard generation.
 *
 * generateFlashcards(input) turns the supplied requirements and interview
 * questions into concise revision flashcards. It is grounded strictly in the
 * provided material: it never invents technologies, company facts, or
 * requirements, and every flashcard must reference at least one existing
 * requirement id (invalid ids are stripped in code). Output shape is validated
 * with Zod; JSON repair is handled inside llmClient.generateJson(). This is a
 * dedicated LLM call, separate from question generation.
 */

export interface FlashcardRequirementInput {
  id: string;
  text: string;
}

export interface FlashcardQuestionInput {
  id: string;
  requirement_ids: string[];
  prompt: string;
  answer_outline: string;
}

export interface GenerateFlashcardsInput {
  requirements: FlashcardRequirementInput[];
  questions: FlashcardQuestionInput[];
}

export interface GenerateFlashcardsDeps {
  /** Injectable LLM client (for tests). Defaults to the env-backed client. */
  client?: Pick<LlmClient, "generateJson">;
}

// Shape we ask the model for (no id — we own that).
const LlmFlashcardSchema = z.object({
  requirement_ids: z.array(z.coerce.string()),
  front: z.string().min(1),
  back: z.string().min(1),
});

const LlmFlashcardsSchema = z.object({
  flashcards: z.array(LlmFlashcardSchema),
});

/** Normalise a single string for comparison. */
function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Normalise front+back for duplicate detection. */
function dedupeKey(front: string, back: string): string {
  // Normalise each side independently so whitespace around the separator
  // cannot make otherwise-identical cards look distinct.
  return `${normalise(front)}\u0000${normalise(back)}`;
}

function renderRequirements(input: GenerateFlashcardsInput): string {
  return (
    input.requirements
      .map((r) => `- ${r.id}: ${r.text}`)
      .join("\n") || "(none provided)"
  );
}

function renderQuestions(input: GenerateFlashcardsInput): string {
  return (
    input.questions
      .map(
        (q) =>
          `- [${q.requirement_ids.join(", ") || "no refs"}] Q: ${q.prompt}\n  A: ${q.answer_outline}`,
      )
      .join("\n") || "(none provided)"
  );
}

function buildPrompt(input: GenerateFlashcardsInput): string {
  return [
    "Create concise interview-revision FLASHCARDS from the material below.",
    "",
    "STRICT RULES:",
    "- Use ONLY the requirements and questions provided. Never invent technologies, company facts, or requirements.",
    "- Each flashcard MUST reference at least one requirement id from the list (by exact id).",
    "- Keep 'front' a short prompt/cue and 'back' a concise, high-value answer for quick revision.",
    "- Do not produce duplicate or near-duplicate flashcards.",
    "",
    "REQUIREMENTS (the only allowed basis, reference by id):",
    renderRequirements(input),
    "",
    "QUESTIONS (context to build cards from):",
    renderQuestions(input),
    "",
    "Return ONLY a JSON object with this exact shape (no ids):",
    "{",
    '  "flashcards": [',
    '    { "requirement_ids": string[], "front": string, "back": string }',
    "  ]",
    "}",
  ].join("\n");
}

export async function generateFlashcards(
  input: GenerateFlashcardsInput,
  deps: GenerateFlashcardsDeps = {},
): Promise<Flashcard[]> {
  const generate = deps.client
    ? deps.client.generateJson.bind(deps.client)
    : generateJson;

  const raw = await generate<unknown>(buildPrompt(input));

  // Validate shape (JSON repair already handled inside generateJson).
  const parsed = LlmFlashcardsSchema.parse(raw);

  const validReqIds = new Set(input.requirements.map((r) => r.id));
  const seen = new Set<string>();
  const flashcards: Flashcard[] = [];

  let counter = 0;
  for (const c of parsed.flashcards) {
    // Keep only references to requirements that actually exist.
    const refs = [
      ...new Set(
        c.requirement_ids
          .map((id) => (validReqIds.has(id) ? id : validReqIds.has(`r${id}`) ? `r${id}` : undefined))
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    if (refs.length === 0) continue; // every flashcard must reference a real requirement

    const key = dedupeKey(c.front, c.back);
    if (seen.has(key)) continue; // drop obvious duplicates
    seen.add(key);

    counter += 1;
    flashcards.push({
      id: `f${counter}`,
      front: c.front,
      back: c.back,
      requirement_ids: refs,
    });
  }

  return flashcards;
}
