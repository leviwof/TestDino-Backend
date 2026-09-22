import { describe, it, expect, vi } from "vitest";
import {
  generateTechnicalQuestions,
  generateBehaviouralQuestions,
  generateSystemDesignQuestions,
  generateCompanyFitQuestions,
  generateAllQuestions,
  type CompanyFitInput,
  type GenerateQuestionsDeps,
  type TechnicalQuestionInput,
} from "./questions.js";

function fakeClient(response: unknown): NonNullable<GenerateQuestionsDeps["client"]> {
  return {
    generateJson: vi.fn(async () => response) as NonNullable<
      GenerateQuestionsDeps["client"]
    >["generateJson"],
  };
}

/** Client returning a different response for each successive call. */
function sequencedClient(
  responses: unknown[],
): NonNullable<GenerateQuestionsDeps["client"]> {
  let i = 0;
  return {
    generateJson: vi.fn(async () => responses[i++]) as NonNullable<
      GenerateQuestionsDeps["client"]
    >["generateJson"],
  };
}

const ROLE: TechnicalQuestionInput = {
  title: "Backend Engineer",
  seniority: "mid",
  responsibilities: ["Build APIs"],
  requirements: [
    { id: "r1", text: "TypeScript / Node.js", kind: "technical", priority: "must" },
    { id: "r2", text: "Databases", kind: "technical", priority: "nice" },
  ],
};

describe("generateTechnicalQuestions", () => {
  it("generates technical questions with unique ids", async () => {
    const client = fakeClient({
      questions: [
        { requirement_ids: ["r1"], prompt: "Explain event loop", answer_outline: "...", difficulty: 2 },
        { requirement_ids: ["r2"], prompt: "Explain indexing", answer_outline: "...", difficulty: 3 },
      ],
    });

    const out = await generateTechnicalQuestions(ROLE, { client });

    expect(out).toHaveLength(2);
    expect(out.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(out.every((q) => q.category === "technical")).toBe(true);
  });

  it("keeps only valid requirement ids and drops questions referencing none", async () => {
    const client = fakeClient({
      questions: [
        { requirement_ids: ["r1", "bogus"], prompt: "Q about r1", answer_outline: "a", difficulty: 1 },
        { requirement_ids: ["nope"], prompt: "Q about nothing", answer_outline: "a", difficulty: 2 },
      ],
    });

    const out = await generateTechnicalQuestions(ROLE, { client });

    expect(out).toHaveLength(1);
    expect(out[0].requirement_ids).toEqual(["r1"]); // bogus stripped
    expect(out.every((q) => q.requirement_ids.length >= 1)).toBe(true);
  });

  it("rejects invalid difficulty via Zod validation", async () => {
    const client = fakeClient({
      questions: [
        { requirement_ids: ["r1"], prompt: "Q", answer_outline: "a", difficulty: 5 },
      ],
    });

    await expect(generateTechnicalQuestions(ROLE, { client })).rejects.toThrow();
  });

  it("throws on structurally invalid LLM output", async () => {
    const client = fakeClient({ not_questions: [] });

    await expect(generateTechnicalQuestions(ROLE, { client })).rejects.toThrow();
  });

  it("removes obvious duplicate questions", async () => {
    const client = fakeClient({
      questions: [
        { requirement_ids: ["r1"], prompt: "Explain the event loop", answer_outline: "a", difficulty: 2 },
        { requirement_ids: ["r1"], prompt: "  explain the   Event Loop  ", answer_outline: "b", difficulty: 3 },
        { requirement_ids: ["r2"], prompt: "Explain indexing", answer_outline: "c", difficulty: 2 },
      ],
    });

    const out = await generateTechnicalQuestions(ROLE, { client });

    expect(out).toHaveLength(2);
    expect(out.map((q) => q.id)).toEqual(["q1", "q2"]);
  });
});

describe("generateBehaviouralQuestions", () => {
  it("generates behavioural questions and keeps ones with no requirement ref", async () => {
    const client = fakeClient({
      questions: [
        { requirement_ids: ["r1"], prompt: "Tell me about a time you shipped under pressure", answer_outline: "STAR", difficulty: 2 },
        { requirement_ids: [], prompt: "Describe a conflict with a teammate", answer_outline: "STAR", difficulty: 2 },
      ],
    });

    const out = await generateBehaviouralQuestions(ROLE, { client });

    expect(out).toHaveLength(2);
    expect(out.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(out.every((q) => q.category === "behavioural")).toBe(true);
    // Second question keeps an empty requirement list rather than being dropped.
    expect(out[1].requirement_ids).toEqual([]);
  });

  it("strips invalid requirement ids but keeps the question", async () => {
    const client = fakeClient({
      questions: [
        { requirement_ids: ["r2", "bogus"], prompt: "Ownership example", answer_outline: "a", difficulty: 1 },
      ],
    });

    const out = await generateBehaviouralQuestions(ROLE, { client });

    expect(out).toHaveLength(1);
    expect(out[0].requirement_ids).toEqual(["r2"]);
  });

  it("rejects invalid difficulty via Zod validation", async () => {
    const client = fakeClient({
      questions: [
        { requirement_ids: [], prompt: "Q", answer_outline: "a", difficulty: 0 },
      ],
    });

    await expect(generateBehaviouralQuestions(ROLE, { client })).rejects.toThrow();
  });
});

describe("generateSystemDesignQuestions", () => {
  it("generates system-design questions with the right category", async () => {
    const client = fakeClient({
      questions: [
        { requirement_ids: ["r2"], prompt: "Design a rate limiter", answer_outline: "buckets, storage, trade-offs", difficulty: 3 },
        { requirement_ids: [], prompt: "Design a URL shortener", answer_outline: "hashing, storage, scale", difficulty: 2 },
      ],
    });

    const out = await generateSystemDesignQuestions(ROLE, { client });

    expect(out).toHaveLength(2);
    expect(out.every((q) => q.category === "system-design")).toBe(true);
    expect(out.map((q) => q.id)).toEqual(["q1", "q2"]);
  });

  it("passes role seniority into the prompt", async () => {
    const client = fakeClient({ questions: [] });

    await generateSystemDesignQuestions(ROLE, { client });

    const prompt = (client.generateJson as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("mid");
    expect(prompt).toContain("SYSTEM-DESIGN");
  });

  it("removes duplicate questions", async () => {
    const client = fakeClient({
      questions: [
        { requirement_ids: [], prompt: "Design a cache", answer_outline: "a", difficulty: 2 },
        { requirement_ids: [], prompt: "  design A   Cache ", answer_outline: "b", difficulty: 3 },
      ],
    });

    const out = await generateSystemDesignQuestions(ROLE, { client });

    expect(out).toHaveLength(1);
  });
});

describe("generateCompanyFitQuestions", () => {
  const FIT_INPUT: CompanyFitInput = {
    ...ROLE,
    company: "Acme",
    companyBrief: {
      summary: "Acme builds warehouse robots.",
      what_they_do: "Autonomous mobile robots and fleet software.",
      sources: ["https://acme.example.com/about"],
    },
  };

  it("generates company-fit questions and uses the brief in the prompt", async () => {
    const client = fakeClient({
      questions: [
        { requirement_ids: [], prompt: "Why do you want to work at Acme?", answer_outline: "motivation", difficulty: 1 },
      ],
    });

    const out = await generateCompanyFitQuestions(FIT_INPUT, { client });

    expect(out).toHaveLength(1);
    expect(out[0].category).toBe("company-fit");

    const prompt = (client.generateJson as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("Acme builds warehouse robots.");
    expect(prompt).toMatch(/NEVER invent company facts/i);
  });

  it("works without a company brief", async () => {
    const client = fakeClient({
      questions: [
        { requirement_ids: [], prompt: "What kind of team environment suits you?", answer_outline: "working style", difficulty: 1 },
      ],
    });

    const out = await generateCompanyFitQuestions({ ...ROLE }, { client });

    expect(out).toHaveLength(1);
    expect(out[0].category).toBe("company-fit");

    const prompt = (client.generateJson as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("(no company brief provided)");
  });

  it("strips invalid requirement ids and keeps the question", async () => {
    const client = fakeClient({
      questions: [
        { requirement_ids: ["r1", "ghost"], prompt: "How do you align with our mission?", answer_outline: "values", difficulty: 2 },
      ],
    });

    const out = await generateCompanyFitQuestions(FIT_INPUT, { client });

    expect(out).toHaveLength(1);
    expect(out[0].requirement_ids).toEqual(["r1"]);
  });
});

describe("generateAllQuestions", () => {
  it("combines all four categories with globally-unique ids and dedupes", async () => {
    // Responses are consumed in fan-out order:
    // technical, behavioural, system-design, company-fit.
    const client = sequencedClient([
      { questions: [{ requirement_ids: ["r1"], prompt: "Explain the event loop", answer_outline: "a", difficulty: 2 }] },
      { questions: [{ requirement_ids: [], prompt: "Tell me about a conflict", answer_outline: "STAR", difficulty: 2 }] },
      { questions: [{ requirement_ids: ["r2"], prompt: "Design a rate limiter", answer_outline: "buckets", difficulty: 3 }] },
      {
        questions: [
          { requirement_ids: [], prompt: "Why work here?", answer_outline: "motivation", difficulty: 1 },
          // Duplicate of the technical question -> should be dropped when combined.
          { requirement_ids: [], prompt: "  explain the   Event Loop ", answer_outline: "dup", difficulty: 1 },
        ],
      },
    ]);

    const out = await generateAllQuestions({ ...ROLE, company: "Acme" }, { client });

    // 4 unique questions (one cross-category duplicate dropped).
    expect(out).toHaveLength(4);
    expect(out.map((q) => q.id)).toEqual(["q1", "q2", "q3", "q4"]);
    expect(out.map((q) => q.category)).toEqual([
      "technical",
      "behavioural",
      "system-design",
      "company-fit",
    ]);

    // One dedicated LLM call per generator, no more.
    expect(client.generateJson).toHaveBeenCalledTimes(4);

    // Original content preserved (only id re-assigned).
    expect(out[0]).toMatchObject({ prompt: "Explain the event loop", requirement_ids: ["r1"] });
    expect(out[2]).toMatchObject({ prompt: "Design a rate limiter", requirement_ids: ["r2"] });
  });
});
