/**
 * Practice-mode sorting logic.
 *
 * Implements pure, confidence-weighted ordering for questions and flashcards.
 *
 * Core sorting rules:
 * 1. Unseen items must appear before seen items.
 * 2. Within the same group (unseen or seen), lower-confidence items get higher
 *    practice priority (appear first).
 * 3. Equal-confidence items are ordered deterministically.
 * 4. The input array is never mutated.
 */

export interface PracticeItem {
  id?: string;
  seen?: boolean;
  confidence?: number | null;
  attempts?: number;
  practiceState?: {
    seen?: boolean;
    confidence?: number | null;
  };
  [key: string]: unknown;
}

export interface PracticeSortOptions<T> {
  /** Custom accessor to determine if an item has been seen/practiced. */
  isSeen?: (item: T) => boolean;
  /** Custom accessor for an item's confidence score (e.g. 1 to 5, 0 to 1). */
  getConfidence?: (item: T) => number | undefined | null;
  /** Custom accessor for item identifier used in deterministic tie-breaking. */
  getId?: (item: T) => string;
}

/**
 * Default rule for determining if an item is seen:
 * - If `seen` is explicitly boolean, use it.
 * - Else if `practiceState.seen` is boolean, use it.
 * - Else if `attempts` is a number, attempts > 0 means seen.
 * - Else if a numeric confidence score exists, it has been seen.
 * - Otherwise, the item is considered unseen.
 */
export function defaultIsSeen<T extends PracticeItem>(item: T): boolean {
  if (typeof item.seen === "boolean") {
    return item.seen;
  }
  if (typeof item.practiceState?.seen === "boolean") {
    return item.practiceState.seen;
  }
  if (typeof item.attempts === "number") {
    return item.attempts > 0;
  }
  if (
    (typeof item.confidence === "number" && !Number.isNaN(item.confidence)) ||
    (typeof item.practiceState?.confidence === "number" &&
      !Number.isNaN(item.practiceState.confidence))
  ) {
    return true;
  }
  return false;
}

/**
 * Default accessor for confidence score.
 */
export function defaultGetConfidence<T extends PracticeItem>(
  item: T,
): number | undefined {
  if (typeof item.confidence === "number" && !Number.isNaN(item.confidence)) {
    return item.confidence;
  }
  if (
    typeof item.practiceState?.confidence === "number" &&
    !Number.isNaN(item.practiceState.confidence)
  ) {
    return item.practiceState.confidence;
  }
  return undefined;
}

/**
 * Default accessor for item ID.
 */
export function defaultGetId<T extends PracticeItem>(
  item: T,
  fallbackIndex: number,
): string {
  if (item.id !== undefined && item.id !== null) {
    return String(item.id);
  }
  return `item-${fallbackIndex}`;
}

/**
 * Pure function that sorts questions or flashcards for practice mode.
 *
 * - Unseen items appear before seen items.
 * - Lower confidence items appear before higher confidence items.
 * - Deterministic tie-breaking for equal confidence items.
 * - Does NOT mutate the input array.
 */
export function sortForPractice<T extends PracticeItem>(
  items: readonly T[],
  options?: PracticeSortOptions<T>,
): T[] {
  if (!items || items.length === 0) {
    return [];
  }

  const isSeenFn = options?.isSeen ?? defaultIsSeen;
  const getConfidenceFn = options?.getConfidence ?? defaultGetConfidence;
  const getIdFn = options?.getId ?? defaultGetId;

  // Create decorated copy without mutating input array
  const decorated = items.map((item, index) => ({
    item,
    originalIndex: index,
    seen: isSeenFn(item),
    confidence: getConfidenceFn(item),
    id: getIdFn(item, index),
  }));

  decorated.sort((a, b) => {
    // 1. Unseen items must appear before seen items
    if (!a.seen && b.seen) return -1;
    if (a.seen && !b.seen) return 1;

    // 2. Within the same group, lower confidence items get higher priority
    const hasConfA = typeof a.confidence === "number";
    const hasConfB = typeof b.confidence === "number";

    if (hasConfA && hasConfB && a.confidence !== b.confidence) {
      return (a.confidence as number) - (b.confidence as number);
    }
    if (hasConfA && !hasConfB) {
      return -1;
    }
    if (!hasConfA && hasConfB) {
      return 1;
    }

    // 3. Deterministic tie-breaking by ID
    const idDiff = a.id.localeCompare(b.id);
    if (idDiff !== 0) {
      return idDiff;
    }

    // 4. Fallback to original index if IDs match
    return a.originalIndex - b.originalIndex;
  });

  return decorated.map((d) => d.item);
}
