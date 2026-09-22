import { describe, it, expect } from "vitest";
import {
  sortForPractice,
  PracticeItem,
} from "./practiceSorting";

describe("sortForPractice", () => {
  it("unseen before seen: places unseen items before seen items regardless of initial array order", () => {
    const items: PracticeItem[] = [
      { id: "q1", seen: true, confidence: 2 },
      { id: "q2", seen: false, confidence: 5 },
      { id: "q3", seen: true, confidence: 1 },
      { id: "q4", seen: false, confidence: 1 },
    ];

    const sorted = sortForPractice(items);

    // Unseen items should come before seen items
    const seenStatuses = sorted.map((item) => Boolean(item.seen));
    expect(seenStatuses).toEqual([false, false, true, true]);

    // Among unseen items: lower confidence (1) before higher (5)
    expect(sorted[0].id).toBe("q4");
    expect(sorted[1].id).toBe("q2");

    // Among seen items: lower confidence (1) before higher (2)
    expect(sorted[2].id).toBe("q3");
    expect(sorted[3].id).toBe("q1");
  });

  it("lower confidence before higher confidence: prioritizes lower confidence items within the same group", () => {
    const seenItems: PracticeItem[] = [
      { id: "q_high", seen: true, confidence: 5 },
      { id: "q_mid", seen: true, confidence: 3 },
      { id: "q_low", seen: true, confidence: 1 },
      { id: "q_zero", seen: true, confidence: 0 },
    ];

    const sorted = sortForPractice(seenItems);
    expect(sorted.map((item) => item.id)).toEqual([
      "q_zero",
      "q_low",
      "q_mid",
      "q_high",
    ]);
  });

  it("equal confidence deterministic order: produces identical, deterministic ordering", () => {
    const itemsWithSameConfidence: PracticeItem[] = [
      { id: "card_c", seen: true, confidence: 3 },
      { id: "card_a", seen: true, confidence: 3 },
      { id: "card_b", seen: true, confidence: 3 },
    ];

    const sorted1 = sortForPractice(itemsWithSameConfidence);
    const sorted2 = sortForPractice(itemsWithSameConfidence);

    // Should break ties deterministically by ID (card_a, card_b, card_c)
    expect(sorted1.map((item) => item.id)).toEqual([
      "card_a",
      "card_b",
      "card_c",
    ]);
    expect(sorted1).toEqual(sorted2);

    // Also verify when reverse order is passed
    const reversed = [...itemsWithSameConfidence].reverse();
    const sortedReversed = sortForPractice(reversed);
    expect(sortedReversed.map((item) => item.id)).toEqual([
      "card_a",
      "card_b",
      "card_c",
    ]);
  });

  it("empty input: handles empty array and falsy inputs cleanly without throwing", () => {
    expect(sortForPractice([])).toEqual([]);
    // @ts-expect-error test undefined/null edge case defensively
    expect(sortForPractice(undefined)).toEqual([]);
    // @ts-expect-error test undefined/null edge case defensively
    expect(sortForPractice(null)).toEqual([]);
  });

  it("input not mutated: does not mutate or alter the original input array or objects", () => {
    const originalInput: PracticeItem[] = Object.freeze([
      Object.freeze({ id: "q3", seen: true, confidence: 4 }),
      Object.freeze({ id: "q1", seen: false, confidence: null }),
      Object.freeze({ id: "q2", seen: true, confidence: 1 }),
    ]) as unknown as PracticeItem[];

    const copyBefore = JSON.parse(JSON.stringify(originalInput));

    const sorted = sortForPractice(originalInput);

    // Returned array is a new reference
    expect(sorted).not.toBe(originalInput);
    // Original input array remains unchanged
    expect(originalInput).toEqual(copyBefore);
    // Elements order in output is properly sorted
    expect(sorted.map((item) => item.id)).toEqual(["q1", "q2", "q3"]);
  });

  it("supports questions or flashcards with custom accessors and nested practiceState", () => {
    const flashcards = [
      {
        id: "fc_1",
        front: "What is closure?",
        back: "A function bundled with lexical scope",
        practiceState: { seen: true, confidence: 4 },
      },
      {
        id: "fc_2",
        front: "What is event loop?",
        back: "Manages call stack and task queues",
        practiceState: { seen: false, confidence: null },
      },
      {
        id: "fc_3",
        front: "Explain prototype chain",
        back: "Delegation mechanism in JS",
        practiceState: { seen: true, confidence: 2 },
      },
    ];

    const sorted = sortForPractice(flashcards);
    expect(sorted.map((item) => item.id)).toEqual(["fc_2", "fc_3", "fc_1"]);
  });
});
