import { describe, it, expect, vi } from "vitest";
import {
  generateGapQuestions,
  type GenerateGapQuestionsDeps,
  type GenerateGapQuestionsInput,
} from "./generateGaps.js";

function fakeClient(response: unknown): NonNullable<GenerateGapQuestionsDeps["client"]> {
  return {
    generateJson: vi.fn(async () => response) as NonNullable<
      GenerateGapQuestionsDeps["client"]
    >["generateJson"],
  };
}

const REQUIREMENTS: GenerateGapQuestionsInput["requirements"] = [
  { id: "r1", text: "TypeScript / Node.js", kind: "technical", priority: "must" },
  { id: "r2", text: "Databases", kind: "technical", priority: "must" },
  { id: "r3", text: "Nice-to-have GraphQL", kind: "technical", priority: "nice" },
];

describe("generateGapQuestions", () => {
  it("makes no LLM call when there are no uncovered must requirements", async () => {
    const client = fakeClient({ questions: [] });

    const out = await generateGapQuestions(
      {
        requirements: REQUIREMENTS,
        existingQuestions: [
          { id: "q1", requirement_ids: ["r1"], category: "technical", prompt: "Q1", answer_outline: "a", difficulty: 2 },
          { id: "q2", requirement_ids: ["r2"], category: "technical", prompt: "Q2", answer_outline: "a", difficulty: 2 },
          // r3 is only "nice", so leaving it uncovered is not a gap.
        ],
      },
      { client },
    );

    expect(out).toEqual([]);
    expect(client.generateJson).not.toHaveBeenCalled();
  });

  it("generates a targeted question for an uncovered must requirement", async () => {
    const client = fakeClient({
      questions: [
        { requirement_ids: ["r2"], category: "technical", prompt: "Explain DB indexing", answer_outline: "b-trees, trade-offs", difficulty: 2 },
      ],
    });

    const out = await generateGapQuestions(
      {
        requirements: REQUIREMENTS,
        existingQuestions: [
          { id: "q1", requirement_ids: ["r1"], category: "technical", prompt: "Explain the event loop", answer_outline: "a", difficulty: 2 },
        ],
      },
      { client },
    );

    expect(client.generateJson).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    // Numbering continues after existing q1.
    expect(out[0].id).toBe("q2");
    expect(out[0].requirement_ids).toEqual(["r2"]);
  });

  it("only targets uncovered requirements and does not regenerate covered ones", async () => {
    // r1 covered, r2 uncovered. Model wrongly returns a question for r1 too.
    const client = fakeClient({
      questions: [
        { requirement_ids: ["r2"], category: "technical", prompt: "DB indexing?", answer_outline: "a", difficulty: 2 },
        { requirement_ids: ["r1"], category: "technical", prompt: "Event loop again?", answer_outline: "a", difficulty: 2 },
      ],
    });

    const out = await generateGapQuestions(
      {
        requirements: REQUIREMENTS,
        existingQuestions: [
          { id: "q1", requirement_ids: ["r1"], category: "technical", prompt: "Explain the event loop", answer_outline: "a", difficulty: 2 },
        ],
      },
      { client },
    );

    // The r1-only question is dropped (r1 isn't an uncovered target).
    expect(out).toHaveLength(1);
    expect(out[0].requirement_ids).toEqual(["r2"]);
  });

  it("keeps only references to the missing requirement (strips extras)", async () => {
    const client = fakeClient({
      questions: [
        { requirement_ids: ["r2", "r1", "bogus"], category: "technical", prompt: "DB indexing?", answer_outline: "a", difficulty: 2 },
      ],
    });

    const out = await generateGapQuestions(
      {
        requirements: REQUIREMENTS,
        existingQuestions: [
          { id: "q1", requirement_ids: ["r1"], category: "technical", prompt: "Event loop", answer_outline: "a", difficulty: 2 },
        ],
      },
      { client },
    );

    expect(out).toHaveLength(1);
    // Only r2 survives: r1 is covered (not a target), bogus doesn't exist.
    expect(out[0].requirement_ids).toEqual(["r2"]);
  });

  it("removes duplicate generated questions", async () => {
    const client = fakeClient({
      questions: [
        { requirement_ids: ["r2"], category: "technical", prompt: "Explain DB indexing", answer_outline: "a", difficulty: 2 },
        { requirement_ids: ["r2"], category: "technical", prompt: "  explain   DB Indexing ", answer_outline: "b", difficulty: 3 },
      ],
    });

    const out = await generateGapQuestions(
      { requirements: REQUIREMENTS, existingQuestions: [] },
      { client },
    );

    expect(out).toHaveLength(1);
  });

  it("throws on structurally invalid LLM output", async () => {
    const client = fakeClient({ not_questions: [] });

    await expect(
      generateGapQuestions(
        { requirements: REQUIREMENTS, existingQuestions: [] },
        { client },
      ),
    ).rejects.toThrow();
  });
});
