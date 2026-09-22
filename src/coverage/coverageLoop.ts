import { checkCoverage } from "./checkCoverage.js";
import {
  generateGapQuestions,
  type GapQuestion,
  type GapRequirementInput,
  type GenerateGapQuestionsDeps,
} from "./generateGaps.js";

/**
 * Coverage improvement loop.
 *
 * runCoverageLoop(input) starts from the existing questions and repeatedly:
 *   1. runs the deterministic checkCoverage(),
 *   2. stops if no MUST requirement is uncovered,
 *   3. otherwise calls generateGapQuestions() to fill the gaps,
 *   4. adds the new (deduplicated) questions and re-checks coverage.
 *
 * At most MAX_ADDITIONAL_PASSES generation passes run. Coverage is ALWAYS
 * determined by checkCoverage() — never by the LLM — so coverage is never faked.
 * Any requirement still uncovered after the passes is reported honestly.
 */

const MAX_ADDITIONAL_PASSES = 2;

export type CoverageLoopQuestion = GapQuestion;

export interface RunCoverageLoopInput {
  requirements: GapRequirementInput[];
  questions: CoverageLoopQuestion[];
}

export interface RunCoverageLoopDeps extends GenerateGapQuestionsDeps {
  /** Injectable gap generator (for tests). Defaults to generateGapQuestions. */
  generateGaps?: typeof generateGapQuestions;
}

export interface RunCoverageLoopResult {
  questions: CoverageLoopQuestion[];
  uncovered_requirement_ids: string[];
  passes: number;
}

/** Normalise a prompt for duplicate detection (matches gap/question modules). */
function dedupeKey(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, " ");
}

function computeUncovered(
  requirements: GapRequirementInput[],
  questions: CoverageLoopQuestion[],
): { allUncovered: string[]; mustUncovered: string[] } {
  const coverage = checkCoverage({
    requirements: requirements.map((r) => ({ id: r.id, priority: r.priority })),
    questions: questions.map((q) => ({ id: q.id, requirement_ids: q.requirement_ids })),
  });
  return {
    allUncovered: coverage.uncovered_requirement_ids,
    mustUncovered: coverage.must_uncovered_requirement_ids,
  };
}

export async function runCoverageLoop(
  input: RunCoverageLoopInput,
  deps: RunCoverageLoopDeps = {},
): Promise<RunCoverageLoopResult> {
  const generateGaps = deps.generateGaps ?? generateGapQuestions;
  const gapDeps: GenerateGapQuestionsDeps = { client: deps.client };

  // Work on a copy; never mutate the caller's array.
  const questions: CoverageLoopQuestion[] = [...input.questions];
  const seenPrompts = new Set(questions.map((q) => dedupeKey(q.prompt)));

  let passes = 0;

  while (passes < MAX_ADDITIONAL_PASSES) {
    // Deterministic coverage check — the only source of truth for coverage.
    const { mustUncovered } = computeUncovered(input.requirements, questions);
    if (mustUncovered.length === 0) break; // no MUST gaps -> stop immediately

    // Fill gaps for the current state (generateGapQuestions re-derives the
    // uncovered MUST set itself and avoids duplicating the questions we pass in).
    const generated = await generateGaps(
      { requirements: input.requirements, existingQuestions: questions },
      gapDeps,
    );
    passes += 1;

    // Add new questions, skipping any duplicate prompts.
    let added = false;
    for (const q of generated) {
      const key = dedupeKey(q.prompt);
      if (seenPrompts.has(key)) continue;
      seenPrompts.add(key);
      questions.push(q);
      added = true;
    }

    // If a pass produced nothing new, further passes can't help — stop to avoid
    // burning the remaining budget on no-op calls.
    if (!added) break;
  }

  // Final coverage is taken from checkCoverage(), so it is never faked.
  const { allUncovered } = computeUncovered(input.requirements, questions);

  return {
    questions,
    uncovered_requirement_ids: allUncovered,
    passes,
  };
}
