import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runPipeline as realRunPipeline } from "../pipeline/runPipeline.js";
import { validateKit as realValidateKit } from "../schema/validateKit.js";
import { toCoreKit, type CoreKit } from "../schema/kit.js";

/**
 * Evaluate CLI.
 *
 * Usage:
 *   npm run evaluate -- --input <input.json> --output <output.json>
 *
 * Reads an array of cases, runs each independently through runPipeline(), and
 * writes a results array in the SAME order as the input. One failing case never
 * stops the others. Successful kits are validated with validateKit() before
 * being written. No MongoDB, no auth, no Express server involved.
 */

export interface EvaluateCase {
  id: string;
  jd: string;
  company_url: string;
  role: string;
  location: string;
  days: number;
}

export type EvaluateCaseResult =
  | { id: string; status: "ok"; kit: CoreKit; error: null }
  | { id: string; status: "failed"; kit: null; error: { code: string; message: string } };

export type EvaluateResult = EvaluateCaseResult;

export interface BatchOutput {
  version: "1.0";
  generated_at: string;
  kits: EvaluateCaseResult[];
}

export interface ParsedArgs {
  input?: string;
  output?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") args.input = argv[++i];
    else if (arg === "--output") args.output = argv[++i];
  }
  return args;
}

/** Minimal, honest logger interface so tests can capture output. */
export interface Logger {
  log: (msg: string) => void;
  error: (msg: string) => void;
}

export interface EvaluateDeps {
  runPipeline?: typeof realRunPipeline;
  validateKit?: typeof realValidateKit;
  logger?: Logger;
}

/** Validate the parsed input is an array of well-formed cases. Throws on failure. */
export function validateInputStructure(data: unknown): EvaluateCase[] {
  if (!Array.isArray(data)) {
    throw new Error("Input JSON must be an array of cases");
  }
  data.forEach((c, i) => {
    if (typeof c !== "object" || c === null) {
      throw new Error(`Case at index ${i} must be an object`);
    }
    const rec = c as Record<string, unknown>;
    if (typeof rec.id !== "string" || rec.id.length === 0) {
      throw new Error(`Case at index ${i} is missing a string "id"`);
    }
    if (typeof rec.jd !== "string") {
      throw new Error(`Case "${rec.id}" is missing a string "jd"`);
    }
    if (typeof rec.company_url !== "string") {
      throw new Error(`Case "${rec.id}" is missing a string "company_url"`);
    }
    if (typeof rec.days !== "number" || !Number.isFinite(rec.days)) {
      throw new Error(`Case "${rec.id}" is missing a numeric "days"`);
    }
  });
  return data as EvaluateCase[];
}

/** Normalise an unknown thrown value into { code, message }. */
function toErrorInfo(err: unknown): { code: string; message: string } {
  if (err instanceof Error) {
    // Use the error's class name (e.g. CrawlError, ZodError) as a stable code.
    return { code: err.name || "Error", message: err.message };
  }
  return { code: "UnknownError", message: String(err) };
}

/**
 * Run every case independently. A failure in one case is captured as a failed
 * result and never interrupts the rest. Ordering matches the input exactly.
 */
export async function runEvaluation(
  cases: EvaluateCase[],
  deps: EvaluateDeps = {},
): Promise<EvaluateResult[]> {
  const runPipeline = deps.runPipeline ?? realRunPipeline;
  const validateKit = deps.validateKit ?? realValidateKit;
  const logger = deps.logger ?? console;

  const results: EvaluateResult[] = [];

  for (const c of cases) {
    logger.log(`[case ${c.id}] started`);
    try {
      const kit = await runPipeline({
        jd: c.jd,
        company_url: c.company_url,
        role: c.role,
        location: c.location,
        days: c.days,
      });

      // 13. Validate the produced kit before writing it.
      const validation = validateKit(kit);
      if (!validation.ok || !validation.kit) {
        throw new Error(`Invalid kit: ${validation.errors.join("; ")}`);
      }

      results.push({ id: c.id, status: "ok", kit: toCoreKit(validation.kit), error: null });
      logger.log(`[case ${c.id}] completed`);
    } catch (err) {
      results.push({ id: c.id, status: "failed", kit: null, error: toErrorInfo(err) });
      logger.error(`[case ${c.id}] failed: ${toErrorInfo(err).message}`);
    }
  }

  return results;
}

/** Full CLI entry point: read input, run, write output. Returns exit code. */
export async function main(argv: string[], deps: EvaluateDeps = {}): Promise<number> {
  const logger = deps.logger ?? console;
  const { input, output } = parseArgs(argv);

  if (!input || !output) {
    logger.error("Usage: evaluate -- --input <input.json> --output <output.json>");
    return 1;
  }

  let cases: EvaluateCase[];
  try {
    const raw = await readFile(input, "utf8");
    const data = JSON.parse(raw);
    cases = validateInputStructure(data);
  } catch (err) {
    logger.error(`Failed to read/parse input: ${toErrorInfo(err).message}`);
    return 1;
  }

  const results = await runEvaluation(cases, deps);

  const outputPayload: BatchOutput = {
    version: "1.0",
    generated_at: new Date().toISOString(),
    kits: results,
  };

  try {
    await writeFile(output, `${JSON.stringify(outputPayload, null, 2)}\n`, "utf8");
  } catch (err) {
    logger.error(`Failed to write output: ${toErrorInfo(err).message}`);
    return 1;
  }

  const failed = results.filter((r) => r.status === "failed").length;
  logger.log(`Done: ${results.length - failed} succeeded, ${failed} failed.`);
  return 0;
}

// Auto-run only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
