import { describe, it, expect } from "vitest";
import { checkCoverage, type CheckCoverageInput } from "./checkCoverage.js";

describe("checkCoverage", () => {
  it("marks all requirements covered when each is referenced", () => {
    const input: CheckCoverageInput = {
      requirements: [
        { id: "r1", priority: "must" },
        { id: "r2", priority: "nice" },
      ],
      questions: [
        { id: "q1", requirement_ids: ["r1"] },
        { id: "q2", requirement_ids: ["r2"] },
      ],
    };

    expect(checkCoverage(input)).toEqual({
      covered_requirement_ids: ["r1", "r2"],
      uncovered_requirement_ids: [],
      must_uncovered_requirement_ids: [],
    });
  });

  it("reports one uncovered requirement", () => {
    const input: CheckCoverageInput = {
      requirements: [
        { id: "r1", priority: "must" },
        { id: "r2", priority: "nice" },
      ],
      questions: [{ id: "q1", requirement_ids: ["r1"] }],
    };

    expect(checkCoverage(input)).toEqual({
      covered_requirement_ids: ["r1"],
      uncovered_requirement_ids: ["r2"],
      must_uncovered_requirement_ids: [],
    });
  });

  it("reports multiple uncovered requirements in declared order", () => {
    const input: CheckCoverageInput = {
      requirements: [
        { id: "r1", priority: "nice" },
        { id: "r2", priority: "must" },
        { id: "r3", priority: "nice" },
      ],
      questions: [{ id: "q1", requirement_ids: [] }],
    };

    expect(checkCoverage(input)).toEqual({
      covered_requirement_ids: [],
      uncovered_requirement_ids: ["r1", "r2", "r3"],
      must_uncovered_requirement_ids: ["r2"],
    });
  });

  it("flags an uncovered must requirement", () => {
    const input: CheckCoverageInput = {
      requirements: [
        { id: "r1", priority: "must" },
        { id: "r2", priority: "must" },
      ],
      questions: [{ id: "q1", requirement_ids: ["r2"] }],
    };

    const out = checkCoverage(input);
    expect(out.uncovered_requirement_ids).toEqual(["r1"]);
    expect(out.must_uncovered_requirement_ids).toEqual(["r1"]);
  });

  it("does not flag an uncovered nice requirement as must", () => {
    const input: CheckCoverageInput = {
      requirements: [
        { id: "r1", priority: "must" },
        { id: "r2", priority: "nice" },
      ],
      questions: [{ id: "q1", requirement_ids: ["r1"] }],
    };

    const out = checkCoverage(input);
    expect(out.uncovered_requirement_ids).toEqual(["r2"]);
    expect(out.must_uncovered_requirement_ids).toEqual([]);
  });

  it("dedupes duplicate requirement ids across question references", () => {
    const input: CheckCoverageInput = {
      requirements: [
        { id: "r1", priority: "must" },
        { id: "r2", priority: "nice" },
      ],
      questions: [
        { id: "q1", requirement_ids: ["r1", "r1"] },
        { id: "q2", requirement_ids: ["r1"] },
      ],
    };

    const out = checkCoverage(input);
    expect(out.covered_requirement_ids).toEqual(["r1"]); // unique, once
    expect(out.uncovered_requirement_ids).toEqual(["r2"]);
  });

  it("ignores unknown requirement ids referenced by questions", () => {
    const input: CheckCoverageInput = {
      requirements: [{ id: "r1", priority: "must" }],
      questions: [{ id: "q1", requirement_ids: ["r1", "ghost", "r999"] }],
    };

    expect(checkCoverage(input)).toEqual({
      covered_requirement_ids: ["r1"],
      uncovered_requirement_ids: [],
      must_uncovered_requirement_ids: [],
    });
  });

  it("handles empty requirements", () => {
    const input: CheckCoverageInput = {
      requirements: [],
      questions: [{ id: "q1", requirement_ids: ["r1"] }],
    };

    expect(checkCoverage(input)).toEqual({
      covered_requirement_ids: [],
      uncovered_requirement_ids: [],
      must_uncovered_requirement_ids: [],
    });
  });

  it("handles empty questions", () => {
    const input: CheckCoverageInput = {
      requirements: [
        { id: "r1", priority: "must" },
        { id: "r2", priority: "nice" },
      ],
      questions: [],
    };

    expect(checkCoverage(input)).toEqual({
      covered_requirement_ids: [],
      uncovered_requirement_ids: ["r1", "r2"],
      must_uncovered_requirement_ids: ["r1"],
    });
  });

  it("does not mutate the input questions", () => {
    const questions = [{ id: "q1", requirement_ids: ["r1", "r1"] }];
    const snapshot = JSON.parse(JSON.stringify(questions));

    checkCoverage({ requirements: [{ id: "r1", priority: "must" }], questions });

    expect(questions).toEqual(snapshot);
  });
});
