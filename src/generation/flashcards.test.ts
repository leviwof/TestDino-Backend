import { describe, it, expect, vi } from "vitest";
import {
  generateFlashcards,
  type GenerateFlashcardsDeps,
  type GenerateFlashcardsInput,
} from "./flashcards.js";
import { createLlmClient } from "./llmClient.js";

function fakeClient(response: unknown): NonNullable<GenerateFlashcardsDeps["client"]> {
  return {
    generateJson: vi.fn(async () => response) as NonNullable<
      GenerateFlashcardsDeps["client"]
    >["generateJson"],
  };
}

const INPUT: GenerateFlashcardsInput = {
  requirements: [
    { id: "r1", text: "TypeScript / Node.js" },
    { id: "r2", text: "Databases" },
  ],
  questions: [
    { id: "q1", requirement_ids: ["r1"], prompt: "Explain the event loop", answer_outline: "single-threaded, callbacks, microtasks" },
    { id: "q2", requirement_ids: ["r2"], prompt: "What is an index?", answer_outline: "speeds lookups, trade-offs on writes" },
  ],
};

describe("generateFlashcards", () => {
  it("generates flashcards with unique ids", async () => {
    const client = fakeClient({
      flashcards: [
        { requirement_ids: ["r1"], front: "Node.js concurrency model?", back: "Single-threaded event loop." },
        { requirement_ids: ["r2"], front: "Purpose of a DB index?", back: "Faster reads, slower writes." },
      ],
    });

    const out = await generateFlashcards(INPUT, { client });

    expect(out).toHaveLength(2);
    expect(out.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("preserves valid requirement ids and drops cards referencing none", async () => {
    const client = fakeClient({
      flashcards: [
        { requirement_ids: ["r1", "bogus"], front: "Event loop?", back: "..." },
        { requirement_ids: ["nope"], front: "Unrelated card", back: "..." },
      ],
    });

    const out = await generateFlashcards(INPUT, { client });

    expect(out).toHaveLength(1);
    expect(out[0].requirement_ids).toEqual(["r1"]); // bogus stripped
    expect(out.every((f) => f.requirement_ids.length >= 1)).toBe(true);
  });

  it("removes obvious duplicate flashcards", async () => {
    const client = fakeClient({
      flashcards: [
        { requirement_ids: ["r1"], front: "Event loop?", back: "Single-threaded." },
        { requirement_ids: ["r1"], front: "  event   Loop? ", back: "  single-threaded. " },
        { requirement_ids: ["r2"], front: "Index?", back: "Faster reads." },
      ],
    });

    const out = await generateFlashcards(INPUT, { client });

    expect(out).toHaveLength(2);
    expect(out.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("throws on structurally invalid LLM output", async () => {
    const client = fakeClient({ not_flashcards: [] });

    await expect(generateFlashcards(INPUT, { client })).rejects.toThrow();
  });

  it("handles a malformed LLM response via the repair mechanism", async () => {
    // Real client: first response invalid JSON, repair valid.
    const transport = vi
      .fn()
      .mockResolvedValueOnce("sure! {oops not json}")
      .mockResolvedValueOnce(
        JSON.stringify({
          flashcards: [
            { requirement_ids: ["r1"], front: "Repaired front", back: "Repaired back" },
          ],
        }),
      );
    const client = createLlmClient(
      { provider: "test", model: "test", maxConcurrency: 2, minIntervalMs: 0 },
      { transport, sleep: async () => {} },
    );

    const out = await generateFlashcards(INPUT, { client });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "f1", front: "Repaired front", requirement_ids: ["r1"] });
    expect(transport).toHaveBeenCalledTimes(2); // original + one repair
  });
});
