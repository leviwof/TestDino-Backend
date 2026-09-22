import { describe, it, expect, vi } from "vitest";
import {
  PIPELINE_STAGES,
  runPipeline,
  type PipelineStageProgress,
  type RunPipelineDeps,
} from "./runPipeline.js";

/** Minimal stub deps that let a run complete without network or LLM calls. */
function stubDeps(over: RunPipelineDeps = {}): RunPipelineDeps {
  const question = {
    id: "q1",
    requirement_ids: ["r1"],
    category: "technical" as const,
    prompt: "TS question",
    answer_outline: "a",
    difficulty: 1 as const,
  };
  return {
    extractRequirements: vi.fn(async () => ({
      title: "Engineer",
      seniority: "",
      responsibilities: [],
      requirements: [{ id: "r1", text: "TS", kind: "technical", priority: "must" }],
      thin: true,
    })) as unknown as RunPipelineDeps["extractRequirements"],
    crawlSite: vi.fn(async () => ({
      pages: [{ url: "https://acme.example.com/", status: 200, text: "About Acme." }],
      unreachable: [],
    })) as unknown as RunPipelineDeps["crawlSite"],
    searchPublicDiscussion: vi.fn(async () => ({ found: false, results: [] })),
    generateCompanyBrief: vi.fn(async () => ({
      summary: "Acme builds robots.",
      what_they_do: "Robots.",
      sources: ["https://acme.example.com/"],
    })) as unknown as RunPipelineDeps["generateCompanyBrief"],
    extractHiringContext: vi.fn(() => ({ hiring_page_found: false })) as unknown as RunPipelineDeps["extractHiringContext"],
    generateAllQuestions: vi.fn(async () => [question]) as unknown as RunPipelineDeps["generateAllQuestions"],
    runCoverageLoop: vi.fn(async () => ({
      questions: [question],
      uncovered_requirement_ids: [],
      passes: 0,
    })) as unknown as RunPipelineDeps["runCoverageLoop"],
    generateFlashcards: vi.fn(async () => []) as unknown as RunPipelineDeps["generateFlashcards"],
    now: () => new Date("2026-09-22T00:00:00.000Z"),
    ...over,
  };
}

const INPUT = { jd: "short jd", company_url: "https://acme.example.com", days: 2 };

describe("runPipeline", () => {
  it("calls every stage in the correct order and returns a valid CoreKit", async () => {
    const order: string[] = [];

    const deps: RunPipelineDeps = {
      extractRequirements: vi.fn(async () => {
        order.push("requirements");
        return {
          title: "Backend Engineer",
          seniority: "mid",
          responsibilities: ["Build APIs"],
          requirements: [
            { id: "r1", text: "TypeScript", kind: "technical", priority: "must" },
          ],
          thin: false,
        };
      }) as unknown as RunPipelineDeps["extractRequirements"],

      crawlSite: vi.fn(async () => {
        order.push("crawl");
        return {
          pages: [{ url: "https://acme.example.com/", status: 200, text: "About Acme." }],
          unreachable: ["https://acme.example.com/broken"],
        };
      }) as unknown as RunPipelineDeps["crawlSite"],

      searchPublicDiscussion: vi.fn(async () => {
        order.push("discussion");
        return {
          found: true,
          results: [{ title: "Acme on HN", url: "https://news.example.com/acme" }],
        };
      }) as unknown as RunPipelineDeps["searchPublicDiscussion"],

      generateCompanyBrief: vi.fn(async () => {
        order.push("brief");
        return {
          summary: "Acme builds robots.",
          what_they_do: "Robots.",
          sources: ["https://acme.example.com/"],
        };
      }) as unknown as RunPipelineDeps["generateCompanyBrief"],

      extractHiringContext: vi.fn(() => {
        order.push("hiring");
        return { hiring_page_found: true };
      }) as unknown as RunPipelineDeps["extractHiringContext"],

      generateAllQuestions: vi.fn(async () => {
        order.push("questions");
        return [
          {
            id: "q1",
            requirement_ids: ["r1"],
            category: "technical" as const,
            prompt: "Explain the event loop",
            answer_outline: "single-threaded",
            difficulty: 2 as const,
          },
        ];
      }) as unknown as RunPipelineDeps["generateAllQuestions"],

      runCoverageLoop: vi.fn(async () => {
        order.push("coverage");
        return {
          questions: [
            {
              id: "q1",
              requirement_ids: ["r1"],
              category: "technical" as const,
              prompt: "Explain the event loop",
              answer_outline: "single-threaded",
              difficulty: 2 as const,
            },
          ],
          uncovered_requirement_ids: [],
          passes: 1,
        };
      }) as unknown as RunPipelineDeps["runCoverageLoop"],

      generateFlashcards: vi.fn(async () => {
        order.push("flashcards");
        return [
          { id: "f1", front: "Event loop?", back: "Single-threaded.", requirement_ids: ["r1"] },
        ];
      }) as unknown as RunPipelineDeps["generateFlashcards"],

      allocateSchedule: vi.fn(() => {
        order.push("schedule");
        return {
          days_available: 1,
          days: [{ day: 1, focus: "Focus: r1", question_ids: ["q1"], minutes: 15 }],
        };
      }) as unknown as RunPipelineDeps["allocateSchedule"],

      now: () => new Date("2026-09-22T00:00:00.000Z"),
    };

    const kit = await runPipeline(
      {
        jd: "We need a backend engineer with TypeScript experience to build APIs.",
        company_url: "https://www.acme.example.com/careers",
        role: "Backend Engineer",
        location: "Remote",
        days: 1,
      },
      deps,
    );

    // 1. Correct stage order (validation runs last, inside runPipeline).
    expect(order).toEqual([
      "requirements",
      "crawl",
      "discussion",
      "brief",
      "hiring",
      "questions",
      "coverage",
      "flashcards",
      "schedule",
    ]);

    // 2. Outputs wired through to a valid CoreKit.
    expect(kit.source.company).toBe("acme");
    expect(kit.source.role).toBe("Backend Engineer");
    expect(kit.source.location).toBe("Remote");
    expect(kit.source.researched_at).toBe("2026-09-22T00:00:00.000Z");
    expect(kit.source.pages_used).toEqual(["https://acme.example.com/"]);
    expect(kit.company_brief.summary).toContain("Acme");
    expect(kit.questions.map((q) => q.id)).toEqual(["q1"]);
    expect(kit.flashcards.map((f) => f.id)).toEqual(["f1"]);
    expect(kit.schedule.days_available).toBe(1);

    // 3. Coverage populated from the loop.
    expect(kit.coverage.passes).toBe(1);
    expect(kit.coverage.uncovered_requirement_ids).toEqual([]);

    // 4. CoreKit shape: no stored-only fields leak through.
    expect(kit).not.toHaveProperty("research_status");
    expect(kit).not.toHaveProperty("research_notes");
  });

  it("continues honestly when discussion is unavailable and research is sparse", async () => {
    const deps: RunPipelineDeps = {
      extractRequirements: vi.fn(async () => ({
        title: "Engineer",
        seniority: "",
        responsibilities: [],
        requirements: [{ id: "r1", text: "TS", kind: "technical", priority: "must" }],
        thin: true,
      })) as unknown as RunPipelineDeps["extractRequirements"],
      crawlSite: vi.fn(async () => ({
        pages: [{ url: "https://acme.example.com/", status: 200, text: "" }],
        unreachable: ["https://acme.example.com/down"],
      })) as unknown as RunPipelineDeps["crawlSite"],
      // Discussion unavailable.
      searchPublicDiscussion: vi.fn(async () => ({ found: false, results: [] })),
      // Honest, minimal brief for sparse research.
      generateCompanyBrief: vi.fn(async () => ({
        summary: "Limited public information available for this company.",
        what_they_do: "",
        sources: ["https://acme.example.com/"],
      })) as unknown as RunPipelineDeps["generateCompanyBrief"],
      generateAllQuestions: vi.fn(async () => [
        {
          id: "q1",
          requirement_ids: ["r1"],
          category: "technical" as const,
          prompt: "TS question",
          answer_outline: "a",
          difficulty: 1 as const,
        },
      ]) as unknown as RunPipelineDeps["generateAllQuestions"],
      runCoverageLoop: vi.fn(async () => ({
        questions: [
          {
            id: "q1",
            requirement_ids: ["r1"],
            category: "technical" as const,
            prompt: "TS question",
            answer_outline: "a",
            difficulty: 1 as const,
          },
        ],
        uncovered_requirement_ids: [],
        passes: 0,
      })) as unknown as RunPipelineDeps["runCoverageLoop"],
      generateFlashcards: vi.fn(async () => []) as unknown as RunPipelineDeps["generateFlashcards"],
      now: () => new Date("2026-09-22T00:00:00.000Z"),
    };

    const kit = await runPipeline(
      { jd: "short jd", company_url: "https://acme.example.com", days: 2 },
      deps,
    );

    // Honest brief preserved; discussion absence is not faked away.
    expect(kit.company_brief.summary).toMatch(/limited public information/i);
    // No discussions found -> still produces a kit; role falls back to title.
    expect(kit.source.role).toBe("Engineer");
    expect(kit.source.location).toBe("");
    // Schedule still has exactly `days` buckets even with one question.
    expect(kit.schedule.days).toHaveLength(2);
  });

  it("reports every pipeline stage, in order, with a real user-facing message", async () => {
    const seen: PipelineStageProgress[] = [];
    await runPipeline(INPUT, stubDeps({ onStage: (p) => void seen.push(p) }));

    // Exactly the declared stage table, in declaration order — no invented or
    // skipped steps.
    expect(seen.map((s) => s.step)).toEqual(PIPELINE_STAGES.map((s) => s.step));
    for (const stage of seen) {
      expect(stage.message.length).toBeGreaterThan(10);
      expect(["crawling", "generating"]).toContain(stage.status);
    }
    // The coarse statuses only ever move forward.
    const asStatuses = seen.map((s) => s.status);
    expect(asStatuses.indexOf("generating")).toBeGreaterThan(asStatuses.lastIndexOf("crawling"));
  });

  it("a broken progress observer never fails the run", async () => {
    const kit = await runPipeline(
      INPUT,
      stubDeps({
        onStage: () => {
          throw new Error("observer exploded");
        },
      }),
    );
    expect(kit.questions).toHaveLength(1);
  });
});
