import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runEvaluation,
  validateInputStructure,
  main,
  type EvaluateCase,
  type EvaluateDeps,
  type Logger,
} from "./evaluate.js";
import type { CoreKit } from "../schema/kit.js";

/** Minimal valid-ish kit object; validateKit is mocked so shape is flexible. */
function fakeKit(id: string): CoreKit {
  return {
    source: {
      company: id,
      company_url: `https://${id}.example.com`,
      role: "Engineer",
      location: "Remote",
      jd_chars: 10,
      researched_at: "2026-09-22T00:00:00.000Z",
      pages_used: [],
    },
    company_brief: { summary: "s", what_they_do: "w", sources: [] },
    role: { title: "Engineer", seniority: "mid", responsibilities: [], requirements: [] },
    questions: [],
    flashcards: [],
    schedule: { days_available: 1, days: [{ day: 1, focus: "f", question_ids: [], minutes: 0 }] },
    coverage: { uncovered_requirement_ids: [], passes: 0 },
  };
}

function silentLogger(): Logger & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, log: (m) => lines.push(m), error: (m) => errors.push(m) };
}

/** Deps whose runPipeline succeeds, and validateKit always passes. */
function okDeps(logger: Logger): EvaluateDeps {
  return {
    runPipeline: vi.fn(async (input) => fakeKit(input.company_url)) as unknown as EvaluateDeps["runPipeline"],
    validateKit: vi.fn((kit) => ({ ok: true, errors: [], kit })) as unknown as EvaluateDeps["validateKit"],
    logger,
  };
}

const CASE = (id: string): EvaluateCase => ({
  id,
  jd: "Backend engineer, TypeScript.",
  company_url: `https://${id}.example.com`,
  role: "Backend Engineer",
  location: "Remote",
  days: 2,
});

describe("runEvaluation", () => {
  it("processes one successful case", async () => {
    const logger = silentLogger();
    const out = await runEvaluation([CASE("acme")], okDeps(logger));

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "acme", status: "ok", error: null });
    expect((out[0] as { kit: CoreKit }).kit).toBeDefined();
    expect(logger.lines).toContain("[case acme] started");
    expect(logger.lines).toContain("[case acme] completed");
  });

  it("processes multiple successful cases in input order", async () => {
    const logger = silentLogger();
    const out = await runEvaluation([CASE("a"), CASE("b"), CASE("c")], okDeps(logger));

    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(out.every((r) => r.status === "ok")).toBe(true);
  });

  it("continues after a failed case (failure does not stop the rest)", async () => {
    const logger = silentLogger();
    const runPipeline = vi.fn(async (input: { company_url: string }) => {
      if (input.company_url.includes("boom")) throw new Error("crawl exploded");
      return fakeKit(input.company_url);
    }) as unknown as EvaluateDeps["runPipeline"];

    const deps: EvaluateDeps = {
      runPipeline,
      validateKit: vi.fn((kit) => ({ ok: true, errors: [], kit })) as unknown as EvaluateDeps["validateKit"],
      logger,
    };

    const out = await runEvaluation([CASE("boom"), CASE("good")], deps);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: "boom",
      status: "failed",
      kit: null,
      error: { code: "Error", message: "crawl exploded" },
    });
    expect(out[1]).toMatchObject({ id: "good", status: "ok", error: null });
    expect(runPipeline).toHaveBeenCalledTimes(2); // both cases attempted
  });

  it("marks a case failed when validateKit rejects the produced kit", async () => {
    const logger = silentLogger();
    const deps: EvaluateDeps = {
      runPipeline: vi.fn(async (input) => fakeKit(input.company_url)) as unknown as EvaluateDeps["runPipeline"],
      validateKit: vi.fn(() => ({ ok: false, errors: ["bad thing"] })) as unknown as EvaluateDeps["validateKit"],
      logger,
    };

    const out = await runEvaluation([CASE("acme")], deps);

    expect(out[0]).toMatchObject({ id: "acme", status: "failed", kit: null });
    expect((out[0] as { error: { message: string } }).error.message).toContain("bad thing");
  });
});

describe("validateInputStructure", () => {
  it("rejects non-array input", () => {
    expect(() => validateInputStructure({ not: "an array" })).toThrow(/must be an array/i);
  });

  it("rejects a case missing required fields", () => {
    expect(() => validateInputStructure([{ id: "x" }])).toThrow(/jd/i);
  });

  it("accepts a well-formed array", () => {
    expect(validateInputStructure([CASE("a")])).toHaveLength(1);
  });
});

describe("main (file I/O)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "evaluate-cli-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads input, writes valid JSON output matching input order", async () => {
    const inputPath = join(dir, "input.json");
    const outputPath = join(dir, "output.json");
    await writeFile(inputPath, JSON.stringify([CASE("a"), CASE("b")]), "utf8");

    const logger = silentLogger();
    const code = await main(
      ["--input", inputPath, "--output", outputPath],
      okDeps(logger),
    );

    expect(code).toBe(0);

    const written = await readFile(outputPath, "utf8");
    // Output must be valid JSON matching Appendix B.
    const parsed = JSON.parse(written);
    expect(parsed.version).toBe("1.0");
    expect(typeof parsed.generated_at).toBe("string");
    expect(Array.isArray(parsed.kits)).toBe(true);
    expect(parsed.kits.map((r: { id: string }) => r.id)).toEqual(["a", "b"]);
    expect(parsed.kits.every((r: { status: string }) => r.status === "ok")).toBe(true);
  });

  it("returns exit code 1 on invalid input JSON without writing output", async () => {
    const inputPath = join(dir, "bad.json");
    const outputPath = join(dir, "out.json");
    await writeFile(inputPath, "{ not valid json ", "utf8");

    const logger = silentLogger();
    const code = await main(
      ["--input", inputPath, "--output", outputPath],
      okDeps(logger),
    );

    expect(code).toBe(1);
    expect(logger.errors.some((e) => /read\/parse input/i.test(e))).toBe(true);
    await expect(readFile(outputPath, "utf8")).rejects.toThrow(); // no output written
  });

  it("writes valid JSON even when some cases fail", async () => {
    const inputPath = join(dir, "input.json");
    const outputPath = join(dir, "output.json");
    await writeFile(inputPath, JSON.stringify([CASE("boom"), CASE("good")]), "utf8");

    const logger = silentLogger();
    const deps: EvaluateDeps = {
      runPipeline: vi.fn(async (input: { company_url: string }) => {
        if (input.company_url.includes("boom")) throw new Error("kaboom");
        return fakeKit(input.company_url);
      }) as unknown as EvaluateDeps["runPipeline"],
      validateKit: vi.fn((kit) => ({ ok: true, errors: [], kit })) as unknown as EvaluateDeps["validateKit"],
      logger,
    };

    const code = await main(["--input", inputPath, "--output", outputPath], deps);
    expect(code).toBe(0);

    const parsed = JSON.parse(await readFile(outputPath, "utf8"));
    expect(parsed.version).toBe("1.0");
    expect(parsed.kits[0]).toMatchObject({ id: "boom", status: "failed", kit: null });
    expect(parsed.kits[1]).toMatchObject({ id: "good", status: "ok", error: null });
  });
});
