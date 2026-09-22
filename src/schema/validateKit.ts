import { StoredKitSchema, type StoredKit } from "./kit.js";

/**
 * Result of validating a kit: Zod shape validation plus referential-integrity
 * checks. `errors` is a list of human-readable messages (empty when valid).
 */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
  /** The parsed kit (with stored-extension defaults applied), if Zod succeeded. */
  kit?: StoredKit;
}

/** Return the ids that appear more than once, in first-seen order. */
function findDuplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dup.add(id);
    else seen.add(id);
  }
  return [...dup];
}

/**
 * Validate a kit.
 *  1. Zod-parse against StoredKitSchema (accepts core kits too — extension
 *     fields default in).
 *  2. Referential-integrity checks with readable error messages.
 */
export function validateKit(input: unknown): ValidationResult {
  const parsed = StoredKitSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    };
  }

  const kit = parsed.data;
  const errors: string[] = [];

  // Collect ids.
  const reqIds = kit.role.requirements.map((r) => r.id);
  const reqSet = new Set(reqIds);
  const qIds = kit.questions.map((q) => q.id);
  const qSet = new Set(qIds);
  const fIds = kit.flashcards.map((f) => f.id);

  // Duplicate ids.
  for (const d of findDuplicates(reqIds)) {
    errors.push(`Duplicate requirement id: "${d}"`);
  }
  for (const d of findDuplicates(qIds)) {
    errors.push(`Duplicate question id: "${d}"`);
  }
  for (const d of findDuplicates(fIds)) {
    errors.push(`Duplicate flashcard id: "${d}"`);
  }

  // Dangling requirement references.
  for (const q of kit.questions) {
    for (const rid of q.requirement_ids) {
      if (!reqSet.has(rid)) {
        errors.push(
          `Question "${q.id}" references unknown requirement id: "${rid}"`,
        );
      }
    }
  }
  for (const f of kit.flashcards) {
    for (const rid of f.requirement_ids) {
      if (!reqSet.has(rid)) {
        errors.push(
          `Flashcard "${f.id}" references unknown requirement id: "${rid}"`,
        );
      }
    }
  }

  // Schedule question references.
  for (const day of kit.schedule.days) {
    for (const qid of day.question_ids) {
      if (!qSet.has(qid)) {
        errors.push(
          `Schedule day ${day.day} references unknown question id: "${qid}"`,
        );
      }
    }
  }

  // Schedule day count and day numbering (must be 1..N).
  const n = kit.schedule.days_available;
  if (kit.schedule.days.length !== n) {
    errors.push(
      `schedule.days has ${kit.schedule.days.length} entries but days_available is ${n}`,
    );
  }
  const dayNums = kit.schedule.days.map((d) => d.day);
  for (const d of findDuplicates(dayNums.map(String))) {
    errors.push(`Duplicate schedule day number: ${d}`);
  }
  for (const dn of dayNums) {
    if (dn < 1 || dn > n) {
      errors.push(`Schedule day number ${dn} is out of range 1..${n}`);
    }
  }

  // Coverage references.
  for (const rid of kit.coverage.uncovered_requirement_ids) {
    if (!reqSet.has(rid)) {
      errors.push(
        `coverage.uncovered_requirement_ids references unknown requirement id: "${rid}"`,
      );
    }
  }

  return { ok: errors.length === 0, errors, kit };
}
