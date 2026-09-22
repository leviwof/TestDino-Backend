/**
 * Deterministic question weighting.
 *
 * calculateQuestionWeight(question, requirements) scores a question by how
 * important and how hard it is:
 *
 *   weight = priorityWeight × difficultyWeight
 *
 * where priorityWeight is taken from the HIGHEST-priority requirement the
 * question references (must = 2, nice = 1) and difficultyWeight equals the
 * difficulty (1..3). This is PURE CODE — no LLM, no I/O, no randomness — and
 * does not mutate its inputs.
 *
 * Unknown requirement ids (not present in `requirements`) are ignored. If a
 * question references no known requirement at all, it has no priority and its
 * weight is 0.
 */

export interface WeightQuestionInput {
  requirement_ids: string[];
  difficulty: 1 | 2 | 3;
}

export interface WeightRequirementInput {
  id: string;
  priority: "must" | "nice";
}

const PRIORITY_WEIGHT: Record<"must" | "nice", number> = {
  must: 2,
  nice: 1,
};

export function calculateQuestionWeight(
  question: WeightQuestionInput,
  requirements: WeightRequirementInput[],
): number {
  const priorityById = new Map(requirements.map((r) => [r.id, r.priority]));

  // Highest priority weight among the question's KNOWN referenced requirements.
  let priorityWeight = 0;
  for (const id of question.requirement_ids) {
    const priority = priorityById.get(id);
    if (priority === undefined) continue; // ignore unknown requirement ids
    priorityWeight = Math.max(priorityWeight, PRIORITY_WEIGHT[priority]);
  }

  // difficulty is already the difficulty weight (1..3).
  return priorityWeight * question.difficulty;
}
