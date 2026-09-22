import { describe, it, expect } from "vitest";
import {
  calculateQuestionWeight,
  type WeightRequirementInput,
} from "./questionWeight.js";

const REQUIREMENTS: WeightRequirementInput[] = [
  { id: "r1", priority: "must" },
  { id: "r2", priority: "nice" },
];

describe("calculateQuestionWeight", () => {
  it("must + difficulty 1 => 2", () => {
    expect(calculateQuestionWeight({ requirement_ids: ["r1"], difficulty: 1 }, REQUIREMENTS)).toBe(2);
  });

  it("must + difficulty 2 => 4", () => {
    expect(calculateQuestionWeight({ requirement_ids: ["r1"], difficulty: 2 }, REQUIREMENTS)).toBe(4);
  });

  it("must + difficulty 3 => 6", () => {
    expect(calculateQuestionWeight({ requirement_ids: ["r1"], difficulty: 3 }, REQUIREMENTS)).toBe(6);
  });

  it("nice + difficulty 1 => 1", () => {
    expect(calculateQuestionWeight({ requirement_ids: ["r2"], difficulty: 1 }, REQUIREMENTS)).toBe(1);
  });

  it("nice + difficulty 3 => 3", () => {
    expect(calculateQuestionWeight({ requirement_ids: ["r2"], difficulty: 3 }, REQUIREMENTS)).toBe(3);
  });

  it("uses the highest priority when multiple requirements are referenced", () => {
    // r2 (nice) + r1 (must) -> must wins: 2 × 2 = 4
    expect(
      calculateQuestionWeight({ requirement_ids: ["r2", "r1"], difficulty: 2 }, REQUIREMENTS),
    ).toBe(4);
  });

  it("ignores unknown requirement ids", () => {
    // Unknown "ghost" ignored; r2 (nice) drives priority: 1 × 3 = 3
    expect(
      calculateQuestionWeight({ requirement_ids: ["ghost", "r2"], difficulty: 3 }, REQUIREMENTS),
    ).toBe(3);
  });

  it("returns 0 when no known requirement is referenced", () => {
    expect(
      calculateQuestionWeight({ requirement_ids: ["ghost"], difficulty: 3 }, REQUIREMENTS),
    ).toBe(0);
  });
});
