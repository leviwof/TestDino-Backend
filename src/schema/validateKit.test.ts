import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateKit } from "./validateKit.js";

const here = dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(
  readFileSync(join(here, "../../fixtures/sample-kit.json"), "utf8"),
);

describe("validateKit", () => {
  it("accepts a valid sample kit", () => {
    const result = validateKit(sample);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("flags a dangling requirement id with a readable message", () => {
    const broken = structuredClone(sample);
    broken.questions[0].requirement_ids = ["r-does-not-exist"];

    const result = validateKit(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("r-does-not-exist")),
    ).toBe(true);
  });
});
