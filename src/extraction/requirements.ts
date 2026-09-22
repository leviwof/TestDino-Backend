import { z } from "zod";
import {
  RequirementKind,
  RequirementPriority,
  type Role,
} from "../schema/kit.js";
import { generateJson, type LlmClient } from "../generation/llmClient.js";

/**
 * Job-description requirement extraction.
 *
 * extractRequirements(jd) asks the LLM to pull ONLY what is present in the JD
 * (title, seniority, responsibilities, requirements) and returns a validated
 * Role. Requirement IDs are assigned deterministically (r1, r2, …) here rather
 * than trusted from the model, for stability.
 *
 * JSON repair is handled inside llmClient.generateJson().
 */

// Shape we ask the model for (no ids — we assign them).
const LlmRequirementSchema = z.object({
  text: z.string().min(1),
  kind: RequirementKind,
  priority: RequirementPriority,
});

const LlmExtractionSchema = z.object({
  title: z.string(),
  seniority: z.string(),
  responsibilities: z.array(z.string()),
  requirements: z.array(LlmRequirementSchema),
});

type LlmExtraction = z.infer<typeof LlmExtractionSchema>;

function buildPrompt(jd: string): string {
  return [
    "You are an expert technical recruiter. Extract structured data from the job description (JD) below.",
    "",
    "STRICT RULES:",
    "- Use ONLY information explicitly present in the JD.",
    "- Never invent technologies, responsibilities, qualifications, or requirements.",
    "- If the JD is short or vague, extract only what is actually present and leave arrays empty if nothing applies.",
    "- Do not add generic boilerplate that is not in the JD.",
    "",
    "CLASSIFY each requirement:",
    '- kind: "technical" (tools, languages, systems), "behavioural" (soft skills, collaboration), or "domain" (industry/business knowledge).',
    '- priority: "must" (required/essential) or "nice" (preferred/bonus/plus).',
    "",
    "Return ONLY a JSON object with this exact shape (no ids, no extra keys):",
    "{",
    '  "title": string,            // role title, "" if not stated',
    '  "seniority": string,        // e.g. junior/mid/senior/lead, "" if not stated',
    '  "responsibilities": string[],',
    '  "requirements": [{ "text": string, "kind": "technical"|"behavioural"|"domain", "priority": "must"|"nice" }]',
    "}",
    "",
    "JOB DESCRIPTION:",
    jd,
  ].join("\n");
}

export interface ExtractRequirementsDeps {
  /** Injectable LLM client (for tests). Defaults to the env-backed client. */
  client?: Pick<LlmClient, "generateJson">;
}

/** Minimum non-whitespace characters for a JD to be considered substantial. */
const THIN_MIN_CHARS = 200;
/** Minimum word count for a JD to be considered substantial. */
const THIN_MIN_WORDS = 30;

/**
 * Deterministic heuristic: does the JD contain very little useful information?
 * Thin JDs should never be padded with manufactured requirements.
 */
export function isThinJobDescription(jd: string): boolean {
  const text = (jd ?? "").trim();
  if (text.length === 0) return true;
  const chars = text.replace(/\s+/g, "").length;
  const words = text.split(/\s+/).filter(Boolean).length;
  return chars < THIN_MIN_CHARS || words < THIN_MIN_WORDS;
}

/**
 * Extraction result: the Role plus a `thin` flag so the pipeline can tell the
 * JD was too sparse to extract much from. `thin` is metadata only — it is not
 * part of CoreKitSchema.
 */
export type ExtractRequirementsResult = Role & { thin: boolean };

export async function extractRequirements(
  jd: string,
  deps: ExtractRequirementsDeps = {},
): Promise<ExtractRequirementsResult> {
  const generate = deps.client
    ? deps.client.generateJson.bind(deps.client)
    : generateJson;

  const raw = await generate<unknown>(buildPrompt(jd));

  // Validate (throws a readable ZodError if the model returned the wrong shape).
  const parsed: LlmExtraction = LlmExtractionSchema.parse(raw);

  // Assign stable, deterministic ids.
  const requirements = parsed.requirements.map((r, i) => ({
    id: `r${i + 1}`,
    text: r.text,
    kind: r.kind,
    priority: r.priority,
  }));

  return {
    title: parsed.title,
    seniority: parsed.seniority,
    responsibilities: parsed.responsibilities,
    requirements,
    // Flag thin JDs; we never manufacture requirements to compensate.
    thin: isThinJobDescription(jd),
  };
}
