import { z } from "zod";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * Environment configuration, validated with Zod.
 *
 * Mongo vars (MONGODB_URI, JWT_SECRET) are optional at the schema level so the
 * evaluate CLI can run without a database. They are enforced only when loading
 * env for the server bootstrap via `loadServerEnv()` / `loadEnv({ requireServer: true })`.
 */

// ---- .env file loading ----

/**
 * Candidate `.env` locations, resolved relative to THIS module so the CLI picks
 * up the file no matter what the current working directory is (the evaluate CLI
 * runs from `server/`, but is often launched from the repo root).
 *
 * Works for both the TypeScript source layout (`server/src/config/env.ts`) and
 * the compiled layout (`server/dist/config/env.js`).
 */
function dotenvCandidates(): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const cwd = process.cwd();
  return [
    // server/.env  (source: src/config/../.. ; compiled: dist/config/../..)
    join(moduleDir, "..", "..", ".env"),
    // server/src/.env (where the key currently lives)
    join(moduleDir, "..", ".env"),
    // repo-root .env
    join(moduleDir, "..", "..", "..", ".env"),
    // cwd fallbacks (CLI launched from server/ or repo root)
    join(cwd, ".env"),
    join(cwd, "server", ".env"),
    join(cwd, "src", ".env"),
  ];
}

let dotenvLoaded = false;

/**
 * Load environment variables from the first `.env` file found.
 *
 * Uses Node's built-in `process.loadEnvFile` (no extra dependency). Existing
 * `process.env` values always win — the file only fills in variables that are
 * not already set — so real shell env / CI secrets are never clobbered.
 *
 * Fails open: a missing `.env` is not an error (the CLI can still run with a
 * real environment). Never logs file contents or values.
 *
 * @param explicitPath When provided, loads exactly that file (used by tests).
 * @returns the path that was loaded, or `undefined` if none existed.
 */
export function loadDotenv(explicitPath?: string): string | undefined {
  const candidates = explicitPath
    ? [resolve(explicitPath)]
    : dotenvCandidates();

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      process.loadEnvFile(path);
      return path;
    } catch {
      // Unreadable/malformed file: skip it and try the next candidate rather
      // than crashing the CLI. Never surface file contents.
    }
  }
  return undefined;
}

/** Parse a string-ish env value into a boolean ("1"/"true"/"yes"/"on" => true). */
function zBool(defaultValue: boolean) {
  return z.preprocess((v) => {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") {
      return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
    }
    return defaultValue;
  }, z.boolean());
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  CORS_ORIGIN: z.string().default("*"),

  // Optional at schema level; required for server bootstrap (see loadEnv).
  MONGODB_URI: z.string().url().optional(),
  JWT_SECRET: z.string().min(1).optional(),

  LLM_PROVIDER: z.string().default("openai"),
  LLM_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("gpt-4o-mini"),
  LLM_MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  LLM_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(0),

  FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  FETCH_MAX_BYTES: z.coerce.number().int().positive().default(2_000_000),
  CRAWL_MAX_PAGES: z.coerce.number().int().positive().default(10),
  CRAWL_DELAY_MS: z.coerce.number().int().nonnegative().default(500),

  // Default false; the batch command's local test sites set this to true.
  ALLOW_PRIVATE_HOSTS: zBool(false),
});

export type Env = z.infer<typeof EnvSchema>;

export interface LoadEnvOptions {
  /** When true, MONGODB_URI and JWT_SECRET must be present. */
  requireServer?: boolean;
  /** Source of env vars; defaults to process.env. */
  source?: Record<string, string | undefined>;
}

/** Format a ZodError into a readable multi-line message. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}

/**
 * Validate and return the environment.
 * Throws an Error with a readable message if validation fails.
 */
export function loadEnv(opts: LoadEnvOptions = {}): Env {
  const { requireServer = false } = opts;

  // When reading the real environment (no explicit source), populate any
  // missing vars from a `.env` file first. Done once; existing vars still win.
  if (opts.source === undefined && !dotenvLoaded) {
    loadDotenv();
    dotenvLoaded = true;
  }

  const source = opts.source ?? process.env;

  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${formatIssues(parsed.error)}`);
  }
  const env = parsed.data;

  if (requireServer) {
    const missing: string[] = [];
    if (!env.MONGODB_URI) missing.push("MONGODB_URI");
    if (!env.JWT_SECRET) missing.push("JWT_SECRET");
    if (missing.length > 0) {
      throw new Error(
        `Missing required env for server bootstrap: ${missing.join(", ")}`,
      );
    }
  }

  return env;
}

/** Env for the server bootstrap (Mongo vars required). */
export const loadServerEnv = (): Env => loadEnv({ requireServer: true });

/** Env for the CLI (Mongo vars optional). */
export const loadCliEnv = (): Env => loadEnv({ requireServer: false });
