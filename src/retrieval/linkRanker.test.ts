import { describe, it, expect } from "vitest";
import { rankLinks, scoreLink } from "./linkRanker.js";

const BASE = "https://example.com/";

describe("scoreLink", () => {
  it("scores high-value keywords above unrelated pages", () => {
    expect(scoreLink("https://example.com/careers", BASE)).toBeGreaterThan(
      scoreLink("https://example.com/terms", BASE),
    );
  });

  it("ranks same-hostname above external", () => {
    expect(scoreLink("https://example.com/jobs", BASE)).toBeGreaterThan(
      scoreLink("https://external.com/jobs", BASE),
    );
  });
});

describe("rankLinks", () => {
  it("ranks careers above an unrelated page", () => {
    const ranked = rankLinks(BASE, [
      "https://example.com/terms",
      "https://example.com/careers",
    ]);
    expect(ranked[0]).toBe("https://example.com/careers");
  });

  it("ranks jobs and engineering highly", () => {
    const ranked = rankLinks(BASE, [
      "https://example.com/privacy",
      "https://example.com/jobs",
      "https://example.com/engineering",
      "https://example.com/legal",
    ]);
    expect(ranked.slice(0, 2)).toEqual(
      expect.arrayContaining([
        "https://example.com/jobs",
        "https://example.com/engineering",
      ]),
    );
  });

  it("gives an unrelated page lower priority", () => {
    const ranked = rankLinks(BASE, [
      "https://example.com/random-page",
      "https://example.com/about",
    ]);
    expect(ranked[ranked.length - 1]).toBe("https://example.com/random-page");
  });

  it("removes duplicate links", () => {
    const ranked = rankLinks(BASE, [
      "https://example.com/careers",
      "https://example.com/careers",
      "https://example.com/jobs",
    ]);
    expect(ranked).toHaveLength(2);
  });

  it("prioritises same hostname over external", () => {
    const ranked = rankLinks(BASE, [
      "https://external.com/careers",
      "https://example.com/careers",
    ]);
    expect(ranked[0]).toBe("https://example.com/careers");
  });
});
