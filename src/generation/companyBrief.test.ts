import { describe, it, expect, vi } from "vitest";
import { generateCompanyBrief, type GenerateCompanyBriefDeps } from "./companyBrief.js";
import { createLlmClient } from "./llmClient.js";

/** Fake client returning a fixed parsed object. */
function fakeClient(response: unknown): NonNullable<GenerateCompanyBriefDeps["client"]> {
  return {
    generateJson: vi.fn(async () => response) as NonNullable<
      GenerateCompanyBriefDeps["client"]
    >["generateJson"],
  };
}

describe("generateCompanyBrief", () => {
  it("produces a brief from useful company pages", async () => {
    const client = fakeClient({
      summary: "Acme builds warehouse robots.",
      what_they_do: "Autonomous mobile robots and fleet software.",
      sources: ["https://acme.example.com/about"],
    });

    const brief = await generateCompanyBrief(
      {
        company: "Acme",
        pages: [
          { url: "https://acme.example.com/about", text: "We build warehouse robots." },
        ],
      },
      { client },
    );

    expect(brief.summary).toContain("Acme");
    expect(brief.what_they_do).toContain("robots");
    expect(brief.sources).toEqual(["https://acme.example.com/about"]);
  });

  it("returns a short honest brief for empty pages and keeps sources", async () => {
    const client = fakeClient({ summary: "x", what_they_do: "y", sources: [] });

    const brief = await generateCompanyBrief(
      {
        company: "Ghost Co",
        pages: [
          { url: "https://ghost.example.com/", text: "" },
          { url: "https://ghost.example.com/x", text: "   " },
        ],
      },
      { client },
    );

    // No LLM call should have happened (empty content path).
    expect(client.generateJson).not.toHaveBeenCalled();
    expect(brief.summary).toMatch(/limited public information/i);
    expect(brief.what_they_do).toBe("");
    // Decision #1: sources retained even when content is unusable.
    expect(brief.sources).toEqual([
      "https://ghost.example.com/",
      "https://ghost.example.com/x",
    ]);
  });

  it("preserves only input source URLs (drops invented ones — decision #2)", async () => {
    const client = fakeClient({
      summary: "s",
      what_they_do: "w",
      sources: [
        "https://acme.example.com/about",
        "https://made-up.example.com/invented", // not in input -> dropped
      ],
    });

    const brief = await generateCompanyBrief(
      {
        company: "Acme",
        pages: [{ url: "https://acme.example.com/about", text: "About Acme." }],
      },
      { client },
    );

    expect(brief.sources).toEqual(["https://acme.example.com/about"]);
  });

  it("handles a malformed LLM response via the repair mechanism", async () => {
    // Real client with a transport: first response invalid JSON, repair valid.
    const transport = vi
      .fn()
      .mockResolvedValueOnce("here is your brief: {oops not json}")
      .mockResolvedValueOnce(
        JSON.stringify({
          summary: "Repaired summary.",
          what_they_do: "Repaired.",
          sources: ["https://acme.example.com/about"],
        }),
      );
    const client = createLlmClient(
      {
        provider: "test",
        model: "test",
        maxConcurrency: 2,
        minIntervalMs: 0,
      },
      { transport, sleep: async () => {} },
    );

    const brief = await generateCompanyBrief(
      {
        company: "Acme",
        pages: [{ url: "https://acme.example.com/about", text: "About Acme." }],
      },
      { client },
    );

    expect(brief.summary).toBe("Repaired summary.");
    expect(brief.sources).toEqual(["https://acme.example.com/about"]);
    expect(transport).toHaveBeenCalledTimes(2); // original + one repair
  });
});
