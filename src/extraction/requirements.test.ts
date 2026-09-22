import { describe, it, expect, vi } from "vitest";
import {
  extractRequirements,
  isThinJobDescription,
  type ExtractRequirementsDeps,
} from "./requirements.js";

/** Build a fake LLM client that returns a fixed parsed object (or throws). */
function fakeClient(response: unknown): NonNullable<ExtractRequirementsDeps["client"]> {
  return {
    generateJson: vi.fn(async () => response) as NonNullable<
      ExtractRequirementsDeps["client"]
    >["generateJson"],
  };
}

describe("extractRequirements", () => {
  it("extracts a normal JD and assigns stable ids r1, r2, ...", async () => {
    const client = fakeClient({
      title: "Backend Engineer",
      seniority: "mid",
      responsibilities: ["Build APIs", "Own reliability"],
      requirements: [
        { text: "TypeScript experience", kind: "technical", priority: "must" },
        { text: "Strong communication", kind: "behavioural", priority: "nice" },
      ],
    });

    const role = await extractRequirements("Some JD text", { client });

    expect(role.title).toBe("Backend Engineer");
    expect(role.seniority).toBe("mid");
    expect(role.responsibilities).toHaveLength(2);
    expect(role.requirements.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(client.generateJson).toHaveBeenCalledOnce();
  });

  it("handles a very short/vague JD without inventing data", async () => {
    const client = fakeClient({
      title: "Intern",
      seniority: "",
      responsibilities: [],
      requirements: [],
    });

    const role = await extractRequirements("Intern wanted.", { client });

    expect(role.title).toBe("Intern");
    expect(role.seniority).toBe("");
    expect(role.responsibilities).toEqual([]);
    expect(role.requirements).toEqual([]);
  });

  it("preserves technical + behavioural classification", async () => {
    const client = fakeClient({
      title: "Engineer",
      seniority: "senior",
      responsibilities: ["Mentor the team"],
      requirements: [
        { text: "Kubernetes", kind: "technical", priority: "must" },
        { text: "Mentorship", kind: "behavioural", priority: "must" },
        { text: "Fintech domain knowledge", kind: "domain", priority: "nice" },
      ],
    });

    const role = await extractRequirements("JD", { client });

    expect(role.requirements.map((r) => r.kind)).toEqual([
      "technical",
      "behavioural",
      "domain",
    ]);
    expect(role.requirements[2].priority).toBe("nice");
  });

  it("works when only a few requirements are present", async () => {
    const client = fakeClient({
      title: "QA",
      seniority: "junior",
      responsibilities: ["Write tests"],
      requirements: [
        { text: "Manual testing", kind: "technical", priority: "must" },
      ],
    });

    const role = await extractRequirements("JD", { client });

    expect(role.requirements).toHaveLength(1);
    expect(role.requirements[0].id).toBe("r1");
  });

  it("throws when the LLM returns invalid structured data", async () => {
    // Missing required fields / wrong enum value.
    const client = fakeClient({
      title: "Engineer",
      requirements: [{ text: "X", kind: "wizardry", priority: "must" }],
    });

    await expect(extractRequirements("JD", { client })).rejects.toThrow();
  });

  it("flags a thin JD on the extraction result", async () => {
    const client = fakeClient({
      title: "Dev",
      seniority: "",
      responsibilities: [],
      requirements: [],
    });

    const result = await extractRequirements("Dev needed.", { client });
    expect(result.thin).toBe(true);
    // Never manufactured requirements to fill the gap.
    expect(result.requirements).toEqual([]);
  });
});

describe("isThinJobDescription", () => {
  const substantialJD =
    "We are hiring a Senior Backend Engineer to design and operate our " +
    "distributed fleet-coordination services. You will own service reliability, " +
    "participate in on-call rotation, mentor junior engineers, and collaborate " +
    "with product to ship features. Required: strong TypeScript and Node.js, " +
    "experience with databases and message queues, and solid communication skills.";

  it("returns false for a normal JD", () => {
    expect(isThinJobDescription(substantialJD)).toBe(false);
  });

  it("returns true for an extremely short JD", () => {
    expect(isThinJobDescription("Dev wanted.")).toBe(true);
    expect(isThinJobDescription("")).toBe(true);
    expect(isThinJobDescription("   ")).toBe(true);
  });

  it("returns false for a JD with meaningful content", () => {
    expect(isThinJobDescription(substantialJD)).toBe(false);
  });
});
