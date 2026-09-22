import type {
  StoredKit,
  StoredQuestion,
  StoredFlashcard,
} from "../schema/kit.js";

/**
 * Thin regeneration service boundary.
 *
 * The full generation pipeline is NOT implemented here — `generateFresh` is an
 * injectable seam that produces newly-generated questions/flashcards for a kit.
 * This module owns only the deterministic merge rules that decide what survives
 * a regeneration:
 *
 *   - remove existing items that are generated && !edited && !pinned (stale),
 *   - preserve user-authored (origin === "user") items,
 *   - preserve user-edited items,
 *   - preserve pinned items,
 *   - append freshly generated items, de-duplicated against the preserved items
 *     and against each other.
 */

/** Freshly generated content supplied by the pipeline seam. */
export interface FreshContent {
  questions: StoredQuestion[];
  flashcards: StoredFlashcard[];
}

export interface RegenerateKitDeps {
  /**
   * Pipeline seam: generate fresh questions/flashcards for the kit. Not wired in
   * this task; when absent, regenerateKit reports the feature is unavailable.
   */
  generateFresh?: (kit: StoredKit) => Promise<FreshContent>;
}

/** Builder provenance flags carried by every stored question/flashcard. */
interface RegenFlags {
  origin: "generated" | "user";
  edited: boolean;
  pinned: boolean;
}

/**
 * An existing item is stale (deletable) ONLY if it was machine-generated and the
 * user has not touched it. User-authored, edited, and pinned items are never
 * stale. Comparisons are explicit so a missing/odd flag can never cause a
 * user-owned item to be treated as deletable.
 */
function isStaleGenerated(item: RegenFlags): boolean {
  return item.origin === "generated" && item.edited !== true && item.pinned !== true;
}

/**
 * Merge freshly-generated items into existing ones under the regeneration rules.
 * Preserved items keep their order and come first; deduped fresh items follow.
 */
export function mergeRegeneratedItems<T extends RegenFlags>(
  existing: T[],
  fresh: T[],
  keyOf: (item: T) => string,
): T[] {
  const preserved = existing.filter((it) => !isStaleGenerated(it));

  const seen = new Set(preserved.map(keyOf));
  const merged: T[] = [...preserved];
  for (const item of fresh) {
    const key = keyOf(item);
    if (seen.has(key)) continue; // dedupe against preserved + earlier fresh
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

const normalise = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

const questionKey = (q: StoredQuestion): string =>
  `${q.category}\u0000${normalise(q.prompt)}`;

const flashcardKey = (f: StoredFlashcard): string =>
  `${normalise(f.front)}\u0000${normalise(f.back)}`;

/** Error thrown when regeneration is requested but the pipeline seam is absent. */
export function regenerationUnavailable(): Error {
  return Object.assign(
    new Error("regeneration pipeline is not available yet"),
    { status: 501, code: "regeneration_unavailable" },
  );
}

/**
 * Regenerate a kit's generated content while preserving edited/pinned/user items
 * and de-duplicating generated content.
 */
export async function regenerateKit(
  kit: StoredKit,
  deps: RegenerateKitDeps = {},
): Promise<StoredKit> {
  if (!deps.generateFresh) {
    throw regenerationUnavailable();
  }
  const fresh = await deps.generateFresh(kit);
  return {
    ...kit,
    questions: mergeRegeneratedItems(kit.questions, fresh.questions, questionKey),
    flashcards: mergeRegeneratedItems(kit.flashcards, fresh.flashcards, flashcardKey),
  };
}
