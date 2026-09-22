import { calculateQuestionWeight } from "./questionWeight.js";

/**
 * Deterministic schedule allocation.
 *
 * allocateSchedule(input) spreads questions across EXACTLY `daysAvailable` days.
 * Questions are ordered by descending weight (see calculateQuestionWeight) so
 * the most important/hardest questions land on the earliest days, then split
 * into balanced day buckets. Every question appears in exactly one day; none is
 * lost or duplicated. When there are more days than questions, the surplus days
 * become review/revision days so the count is still exactly `daysAvailable`.
 *
 * PURE CODE — no LLM, no I/O, no randomness. Inputs are not mutated.
 */

export interface ScheduleQuestionInput {
  id: string;
  requirement_ids: string[];
  difficulty: 1 | 2 | 3;
}

export interface ScheduleRequirementInput {
  id: string;
  priority: "must" | "nice";
}

export interface AllocateScheduleInput {
  daysAvailable: number;
  questions: ScheduleQuestionInput[];
  requirements: ScheduleRequirementInput[];
}

export interface ScheduleDay {
  day: number;
  focus: string;
  question_ids: string[];
  minutes: number;
}

export interface Schedule {
  days_available: number;
  days: ScheduleDay[];
}

/** Minutes budgeted per question, by difficulty. */
const MINUTES_BY_DIFFICULTY: Record<1 | 2 | 3, number> = {
  1: 10,
  2: 15,
  3: 20,
};

function questionMinutes(q: ScheduleQuestionInput): number {
  return MINUTES_BY_DIFFICULTY[q.difficulty];
}

/**
 * Deterministic focus label from the questions assigned to a day: the distinct
 * requirement ids they reference, in first-seen order. Empty day => review.
 */
function buildFocus(dayQuestions: ScheduleQuestionInput[]): string {
  if (dayQuestions.length === 0) return "Review and revision";

  const refs: string[] = [];
  const seen = new Set<string>();
  for (const q of dayQuestions) {
    for (const id of q.requirement_ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      refs.push(id);
    }
  }

  return refs.length > 0 ? `Focus: ${refs.join(", ")}` : "General practice";
}

export function allocateSchedule(input: AllocateScheduleInput): Schedule {
  const { daysAvailable, questions, requirements } = input;

  // Rule 9 (invalid input): fail clearly rather than guess.
  if (!Number.isInteger(daysAvailable) || daysAvailable < 1) {
    throw new Error(
      `allocateSchedule: daysAvailable must be a positive integer, received ${daysAvailable}`,
    );
  }

  // Order by descending weight without mutating the caller's array. Array.sort
  // is stable, so equal-weight questions keep their original relative order.
  const ordered = [...questions].sort(
    (a, b) =>
      calculateQuestionWeight(b, requirements) - calculateQuestionWeight(a, requirements),
  );

  // Balanced sequential chunking: the first `remainder` days get one extra
  // question. This front-loads the highest-weight questions and, when there are
  // more days than questions, naturally yields empty (review) trailing days.
  const n = ordered.length;
  const base = Math.floor(n / daysAvailable);
  const remainder = n % daysAvailable;

  const days: ScheduleDay[] = [];
  let cursor = 0;

  for (let d = 0; d < daysAvailable; d += 1) {
    const size = base + (d < remainder ? 1 : 0);
    const dayQuestions = ordered.slice(cursor, cursor + size);
    cursor += size;

    days.push({
      day: d + 1,
      focus: buildFocus(dayQuestions),
      question_ids: dayQuestions.map((q) => q.id),
      minutes: dayQuestions.reduce((sum, q) => sum + questionMinutes(q), 0),
    });
  }

  const schedule: Schedule = {
    days_available: daysAvailable,
    days,
  };

  // Deterministic self-check: guarantees the invariants below hold for any
  // output this function produces. A failure here means a bug in the allocator,
  // not bad user input — so it throws rather than returning a broken schedule.
  validateSchedule(schedule, { questions, requirements });

  return schedule;
}

/**
 * Deterministic validation of an allocated schedule against its inputs. Throws
 * `ScheduleValidationError` on the first violated invariant. Pure and
 * side-effect free — safe to call on any schedule/inputs pair.
 *
 * Invariants checked:
 *  1. days_available is a positive integer.
 *  2. days.length === days_available.
 *  3. day numbers are exactly 1..N in order.
 *  4. every question id appears at most once across all days.
 *  5. the scheduled ids are exactly the set of input question ids (each input
 *     question scheduled exactly once; nothing invented).
 *  6. every MUST requirement that is referenced by at least one input question
 *     is represented in some day. (An uncovered MUST requirement with NO
 *     question is left honest — we never invent a question for it.)
 *  7. every day's minutes is a non-negative integer.
 */
export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleValidationError";
  }
}

export function validateSchedule(
  schedule: Schedule,
  input: { questions: ScheduleQuestionInput[]; requirements: ScheduleRequirementInput[] },
): void {
  const fail = (msg: string): never => {
    throw new ScheduleValidationError(`Invalid schedule: ${msg}`);
  };

  // 1. days_available positive integer.
  if (!Number.isInteger(schedule.days_available) || schedule.days_available < 1) {
    fail(`days_available must be a positive integer, got ${schedule.days_available}`);
  }

  // 2. day count matches days_available.
  if (schedule.days.length !== schedule.days_available) {
    fail(
      `expected ${schedule.days_available} days, got ${schedule.days.length}`,
    );
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < schedule.days.length; i += 1) {
    const day = schedule.days[i];

    // 3. day numbers are exactly 1..N in order.
    if (day.day !== i + 1) {
      fail(`day at index ${i} has number ${day.day}, expected ${i + 1}`);
    }

    // 7. minutes non-negative integer.
    if (!Number.isInteger(day.minutes) || day.minutes < 0) {
      fail(`day ${day.day} has invalid minutes ${day.minutes}`);
    }

    // 4. no question id appears more than once.
    for (const id of day.question_ids) {
      if (seenIds.has(id)) fail(`question "${id}" is scheduled more than once`);
      seenIds.add(id);
    }
  }

  // 5. scheduled ids are exactly the input question ids (nothing lost/invented).
  const inputIds = new Set(input.questions.map((q) => q.id));
  if (seenIds.size !== inputIds.size) {
    fail(`scheduled ${seenIds.size} questions but received ${inputIds.size}`);
  }
  for (const id of inputIds) {
    if (!seenIds.has(id)) fail(`input question "${id}" is not scheduled`);
  }
  for (const id of seenIds) {
    if (!inputIds.has(id)) fail(`scheduled question "${id}" was not in the input`);
  }

  // 6. every MUST requirement that has at least one question is represented.
  const reqsWithQuestions = new Set<string>();
  for (const q of input.questions) {
    for (const rid of q.requirement_ids) reqsWithQuestions.add(rid);
  }
  // Requirement ids actually represented in the scheduled days.
  const scheduledReqIds = new Set<string>();
  for (const day of schedule.days) {
    for (const qid of day.question_ids) {
      const q = input.questions.find((x) => x.id === qid);
      if (!q) continue;
      for (const rid of q.requirement_ids) scheduledReqIds.add(rid);
    }
  }
  for (const req of input.requirements) {
    if (req.priority !== "must") continue;
    // Honest exception: a MUST requirement with no question is left uncovered
    // rather than fabricated. Only enforce coverage when a question exists.
    if (reqsWithQuestions.has(req.id) && !scheduledReqIds.has(req.id)) {
      fail(`must requirement "${req.id}" is referenced by a question but not scheduled`);
    }
  }
}
