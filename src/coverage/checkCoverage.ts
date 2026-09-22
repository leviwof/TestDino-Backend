/**
 * Deterministic coverage checker.
 *
 * checkCoverage(input) reports which requirements are exercised by at least one
 * question. It is PURE CODE — no LLM, no I/O, no randomness — and does not
 * mutate its inputs. Output order follows the order requirements are declared
 * in the input, so results are stable and deterministic.
 *
 * A requirement is "covered" when its id appears in some question's
 * requirement_ids. Unknown ids referenced by questions are ignored (never crash).
 */

export interface CoverageRequirementInput {
  id: string;
  priority: "must" | "nice";
}

export interface CoverageQuestionInput {
  id: string;
  requirement_ids: string[];
}

export interface CheckCoverageInput {
  requirements: CoverageRequirementInput[];
  questions: CoverageQuestionInput[];
}

export interface CoverageResult {
  covered_requirement_ids: string[];
  uncovered_requirement_ids: string[];
  must_uncovered_requirement_ids: string[];
}

export function checkCoverage(input: CheckCoverageInput): CoverageResult {
  // Set of requirement ids referenced by any question. Unknown ids are allowed
  // in here; they simply won't match a real requirement below.
  const referenced = new Set<string>();
  for (const q of input.questions) {
    for (const id of q.requirement_ids) {
      referenced.add(id);
    }
  }

  const covered_requirement_ids: string[] = [];
  const uncovered_requirement_ids: string[] = [];
  const must_uncovered_requirement_ids: string[] = [];

  // Iterate real requirements in declared order; dedupe by id so a requirement
  // listed twice is only classified once.
  const seen = new Set<string>();
  for (const req of input.requirements) {
    if (seen.has(req.id)) continue;
    seen.add(req.id);

    if (referenced.has(req.id)) {
      covered_requirement_ids.push(req.id);
    } else {
      uncovered_requirement_ids.push(req.id);
      if (req.priority === "must") {
        must_uncovered_requirement_ids.push(req.id);
      }
    }
  }

  return {
    covered_requirement_ids,
    uncovered_requirement_ids,
    must_uncovered_requirement_ids,
  };
}
