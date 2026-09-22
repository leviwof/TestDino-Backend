import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadDotenv } from "./env.js";
import { describeLlmConfig, formatLlmConfigReport } from "../generation/llmClient.js";

// A fake key — never a real secret. Long enough to prove length is reported.
const FAKE_KEY = "sk-test-FAKEKEY-0000000000000000000000000000";

describe("loadDotenv (reads LLM_API_KEY from a .env file, no secret exposure)", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "env-test-"));
    for (const k of ["LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("loads LLM_API_KEY (and friends) from a controlled .env file", () => {
    const envPath = join(dir, ".env");
    writeFileSync(
      envPath,
      `LLM_PROVIDER=openai\nLLM_API_KEY=${FAKE_KEY}\nLLM_MODEL=gpt-4o-mini\n`,
    );

    const loaded = loadDotenv(envPath);

    expect(loaded).toBe(envPath);
    expect(process.env.LLM_API_KEY).toBe(FAKE_KEY);

    // The safe config report shows the key is configured with a non-zero length…
    const report = describeLlmConfig({
      provider: process.env.LLM_PROVIDER!,
      model: process.env.LLM_MODEL!,
      apiKey: process.env.LLM_API_KEY,
    });
    expect(report.apiKeyConfigured).toBe(true);
    expect(report.apiKeyLength).toBe(FAKE_KEY.length);

    // …but never prints the secret itself.
    const text = formatLlmConfigReport(report);
    expect(text).toContain("API key configured: true");
    expect(text).toContain(`API key length: ${FAKE_KEY.length}`);
    expect(text).not.toContain(FAKE_KEY);
  });

  it("does not override an already-set variable (shell/CI env wins)", () => {
    process.env.LLM_API_KEY = "from-environment";
    const envPath = join(dir, ".env");
    writeFileSync(envPath, `LLM_API_KEY=${FAKE_KEY}\n`);

    loadDotenv(envPath);

    expect(process.env.LLM_API_KEY).toBe("from-environment");
  });

  it("fails open when no .env file exists (returns undefined, does not throw)", () => {
    const missing = join(dir, "does-not-exist.env");
    expect(loadDotenv(missing)).toBeUndefined();
  });
});
