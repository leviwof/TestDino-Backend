import { describe, it, expect } from "vitest";
import { mergeRegeneratedItems, regenerateKit, type FreshContent } from "./kitRegeneration.js";
import type { StoredQuestion, StoredFlashcard, StoredKit } from "../schema/kit.js";

// ---- fixtures ----

function q(
  id: string,
  prompt: string,
  flags: Partial<Pick<StoredQuestion, "origin" | "edited" | "pinned" | "order">> = {},
): StoredQuestion {
  return {
    id,
    requirement_ids: [],
    category: "technical",
    prompt,
    answer_outline: "outline",
    difficulty: 2,
    origin: flags.origin ?? "generated",
    edited: flags.edited ?? false,
    pinned: flags.pinned ?? false,
    order: flags.order ?? 0,
  };
}

function fc(
  id: string,
  front: string,
  back: string,
  flags: Partial<Pick<StoredFlashcard, "origin" | "edited" | "pinned" | "order">> = {},
): StoredFlashcard {
  return {
    id,
    front,
    back,
    requirement_ids: [],
    origin: flags.origin ?? "generated",
    edited: flags.edited ?? false,
    pinned: flags.pinned ?? false,
    order: flags.order ?? 0,
  };
}

const keyOf = (x: StoredQuestion) => `${x.category}\u0000${x.prompt.toLowerCase().trim()}`;

describe("mergeRegeneratedItems (regeneration rules)", () => {
  it("removes generated + unedited + unpinned items and replaces them with fresh", () => {
    const existing = [q("q1", "Stale generated")];
    const fresh = [q("q2", "Brand new generated")];
    const merged = mergeRegeneratedItems(existing, fresh, keyOf);

    const prompts = merged.map((m) => m.prompt);
    expect(prompts).not.toContain("Stale generated");
    expect(prompts).toContain("Brand new generated");
  });

  it("preserves edited generated items", () => {
    const existing = [q("q1", "Edited question", { edited: true })];
    const merged = mergeRegeneratedItems(existing, [], keyOf);
    expect(merged.map((m) => m.prompt)).toEqual(["Edited question"]);
  });

  it("preserves pinned generated items", () => {
    const existing = [q("q1", "Pinned question", { pinned: true })];
    const merged = mergeRegeneratedItems(existing, [], keyOf);
    expect(merged.map((m) => m.prompt)).toEqual(["Pinned question"]);
  });

  it("preserves user-created items", () => {
    const existing = [q("q1", "User question", { origin: "user" })];
    const merged = mergeRegeneratedItems(existing, [], keyOf);
    expect(merged.map((m) => m.prompt)).toEqual(["User question"]);
  });

  it("preserves item metadata (origin/edited/pinned/order) of surviving items", () => {
    const existing = [
      q("q1", "Pinned", { pinned: true, order: 7 }),
      q("q2", "User authored", { origin: "user", edited: true, order: 3 }),
    ];
    const merged = mergeRegeneratedItems(existing, [], keyOf);
    expect(merged).toEqual(existing); // full objects preserved, unchanged
  });

  it("removes duplicates: fresh items matching a preserved item are dropped", () => {
    const existing = [q("q1", "Pinned question", { pinned: true })];
    const fresh = [
      q("q2", "Pinned question"), // duplicate of the preserved pinned item
      q("q3", "Unique new question"),
    ];
    const merged = mergeRegeneratedItems(existing, fresh, keyOf);
    const prompts = merged.map((m) => m.prompt);
    expect(prompts.filter((p) => p === "Pinned question")).toHaveLength(1);
    expect(prompts).toContain("Unique new question");
  });

  it("removes duplicates among the fresh batch itself", () => {
    const fresh = [q("q1", "Same prompt"), q("q2", "Same prompt")];
    const merged = mergeRegeneratedItems([], fresh, keyOf);
    expect(merged).toHaveLength(1);
  });
});

describe("regenerateKit", () => {
  function kitWith(questions: StoredQuestion[], flashcards: StoredFlashcard[]): StoredKit {
    return {
      source: {
        company: "Acme",
        company_url: "https://acme.example.com",
        role: "Engineer",
        location: "Remote",
        jd_chars: 10,
        researched_at: "2026-01-01T00:00:00.000Z",
        pages_used: [],
      },
      company_brief: { summary: "", what_they_do: "", sources: [] },
      role: { title: "Engineer", seniority: "senior", responsibilities: [], requirements: [] },
      questions,
      flashcards,
      schedule: { days_available: 1, days: [] },
      coverage: { uncovered_requirement_ids: [], passes: 0 },
    };
  }

  it("regenerates stale items while preserving edited/pinned/user across questions and flashcards", async () => {
    const kit = kitWith(
      [
        q("q1", "Stale generated"),
        q("q2", "Edited", { edited: true }),
        q("q3", "Pinned", { pinned: true }),
        q("q4", "User authored", { origin: "user" }),
      ],
      [fc("f1", "Stale front", "Stale back"), fc("f2", "Pinned front", "Pinned back", { pinned: true })],
    );

    const fresh: FreshContent = {
      questions: [q("q5", "Fresh generated"), q("q6", "Pinned")], // q6 dupes the pinned q3
      flashcards: [fc("f3", "Fresh front", "Fresh back")],
    };

    const result = await regenerateKit(kit, { generateFresh: async () => fresh });

    const prompts = result.questions.map((x) => x.prompt);
    expect(prompts).toEqual(
      expect.arrayContaining(["Edited", "Pinned", "User authored", "Fresh generated"]),
    );
    expect(prompts).not.toContain("Stale generated");
    expect(prompts.filter((p) => p === "Pinned")).toHaveLength(1); // dedupe vs pinned

    const fronts = result.flashcards.map((x) => x.front);
    expect(fronts).toContain("Pinned front");
    expect(fronts).toContain("Fresh front");
    expect(fronts).not.toContain("Stale front");
  });

  it("propagates a generation failure (so the caller can preserve the existing kit)", async () => {
    const kit = kitWith([q("q1", "Stale")], []);
    await expect(
      regenerateKit(kit, {
        generateFresh: async () => {
          throw new Error("LLM unavailable");
        },
      }),
    ).rejects.toThrow(/LLM unavailable/);
  });
});
