import { describe, it, expect, vi } from "vitest";
import { runCoverageLoop, type RunCoverageLoopInput } from "./coverageLoop.js";
import type { GapQuestion } from "./generateGaps.js";

const REQUIREMENTS: RunCoverageLoopInput["requirements"] = [
  { id: "r1", text: "TypeScript / Node.js", kind: "technical", priority: "must" },
  { id: "r2", text: "Databases", kind: "technical", priority: "must" },
  { id: "r3", text: "GraphQL", kind: "technical", priority: "nice" },
];

function q(id: string, reqIds: string[], prompt: string): GapQuestion {
  return {
    id,
    requirement_ids: reqIds,
    category: "technical",
    prompt,
    answer_outline: "outline",
    difficulty: 2,
  };
}

/** A gap generator that yields the given batch on each successive call. */
function scriptedGaps(batches: GapQuestion[][]) {
  let i = 0;
  return vi.fn(async () => batches[i++] ?? []);
}

describe("runCoverageLoop", () => {
  it("stops immediately when all must requirements are already covered", async () => {
    const generateGaps = scriptedGaps([]);

    const out = await runCoverageLoop(
      {
        requirements: REQUIREMENTS,
        questions: [q("q1", ["r1"], "A"), q("q2", ["r2"], "B")],
      },
      { generateGaps },
    );

    expect(generateGaps).not.toHaveBeenCalled();
    expect(out.passes).toBe(0);
    // r3 (nice) is uncovered but never a *must* gap, so the loop doesn't run;
    // it's still reported honestly in the final uncovered list.
    expect(out.uncovered_requirement_ids).toEqual(["r3"]);
  });

  it("fixes all gaps in a single pass", async () => {
    const generateGaps = scriptedGaps([[q("q2", ["r2"], "DB indexing?")]]);

    const out = await runCoverageLoop(
      { requirements: REQUIREMENTS, questions: [q("q1", ["r1"], "Event loop?")] },
      { generateGaps },
    );

    expect(generateGaps).toHaveBeenCalledTimes(1);
    expect(out.passes).toBe(1);
    // All MUST requirements covered; r3 (nice) remains uncovered and reported.
    expect(out.uncovered_requirement_ids).toEqual(["r3"]);
    expect(out.questions.map((x) => x.id)).toEqual(["q1", "q2"]);
  });

  it("fixes remaining gaps on the second pass", async () => {
    // r1 and r2 both uncovered. Pass 1 covers r1, pass 2 covers r2.
    const generateGaps = scriptedGaps([
      [q("q1", ["r1"], "Event loop?")],
      [q("q2", ["r2"], "DB indexing?")],
    ]);

    const out = await runCoverageLoop(
      { requirements: REQUIREMENTS, questions: [] },
      { generateGaps },
    );

    expect(generateGaps).toHaveBeenCalledTimes(2);
    expect(out.passes).toBe(2);
    // Both MUST requirements covered across the two passes; r3 (nice) remains.
    expect(out.uncovered_requirement_ids).toEqual(["r3"]);
  });

  it("keeps a requirement uncovered after the maximum passes (no infinite loop)", async () => {
    // Each pass only ever fixes r1; r2 stays uncovered. Loop must cap at 2.
    const generateGaps = vi.fn(async () => [q("qx", ["r1"], `covers r1 ${Math.random()}`)]);

    const out = await runCoverageLoop(
      { requirements: REQUIREMENTS, questions: [] },
      { generateGaps },
    );

    expect(generateGaps).toHaveBeenCalledTimes(2); // never more than 2
    expect(out.passes).toBe(2);
    expect(out.uncovered_requirement_ids).toContain("r2"); // reported honestly
  });

  it("does not add duplicate questions", async () => {
    // Both passes return the same prompt (case/space variants) for r1, leaving r2.
    const generateGaps = scriptedGaps([
      [q("qa", ["r1"], "Explain the event loop")],
      [q("qb", ["r1"], "  explain THE event   loop ")],
    ]);

    const out = await runCoverageLoop(
      { requirements: REQUIREMENTS, questions: [] },
      { generateGaps },
    );

    const eventLoopCards = out.questions.filter((x) =>
      x.prompt.toLowerCase().includes("event") && x.prompt.toLowerCase().includes("loop"),
    );
    expect(eventLoopCards).toHaveLength(1); // duplicate not added
  });

  it("reports the correct pass count when a pass produces nothing new", async () => {
    // Pass 1 covers nothing that matters (empty batch) -> loop stops early.
    const generateGaps = scriptedGaps([[]]);

    const out = await runCoverageLoop(
      { requirements: REQUIREMENTS, questions: [q("q1", ["r1"], "Event loop?")] },
      { generateGaps },
    );

    // r2 still uncovered, one pass attempted, empty -> stop (no second pass).
    expect(generateGaps).toHaveBeenCalledTimes(1);
    expect(out.passes).toBe(1);
    expect(out.uncovered_requirement_ids).toContain("r2");
  });
});
