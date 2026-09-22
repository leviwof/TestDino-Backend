import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";

import { runPipeline, type RunPipelineDeps } from "./runPipeline.js";
import { validateKit } from "../schema/validateKit.js";
import { extractRequirements } from "../extraction/requirements.js";
import { crawlSite } from "../retrieval/crawler.js";
import { searchPublicDiscussion } from "../retrieval/discussions.js";
import { generateCompanyBrief } from "../generation/companyBrief.js";
import { generateAllQuestions } from "../generation/questions.js";
import { generateFlashcards } from "../generation/flashcards.js";
import type { LlmClient } from "../generation/llmClient.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = join(HERE, "..", "..", "fixtures", "site");

/**
 * Tiny static file server used ONLY for this test. Serves the fixture site over
 * real HTTP so the crawler exercises its genuine fetch path. Returns 404 for
 * robots.txt (crawler fails open) and anything unknown.
 */
async function startFixtureServer(): Promise<{ server: Server; baseUrl: string }> {
  const routes: Record<string, string> = {
    "/": "index.html",
    "/index.html": "index.html",
    "/careers.html": "careers.html",
    "/engineering.html": "engineering.html",
  };

  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const file = routes[path];
    if (!file) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    try {
      const body = await readFile(join(SITE_DIR, file), "utf8");
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(body);
    } catch {
      res.statusCode = 500;
      res.end("error");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * Fake LLM client: dispatches on prompt content and returns valid JSON for each
 * generation stage. The real stage code (Zod validation, id assignment, dedupe,
 * filtering) still runs — only the model transport is faked.
 */
function fakeLlmClient(): Pick<LlmClient, "generateJson"> {
  const generateJson = async (prompt: string): Promise<unknown> => {
    const p = prompt.toUpperCase();

    // Requirement extraction (JD -> role). Two must-have technical requirements.
    if (p.includes("JOB DESCRIPTION")) {
      return {
        title: "Senior Backend Engineer",
        seniority: "senior",
        responsibilities: ["Design fleet services", "Collaborate with SRE"],
        requirements: [
          { text: "TypeScript / Node.js", kind: "technical", priority: "must" },
          { text: "PostgreSQL / relational databases", kind: "technical", priority: "must" },
        ],
      };
    }

    // Company brief. Echo back a subset of the <source url="..."> URLs so the
    // real source-filtering logic has something valid to keep.
    if (p.includes("FACTUAL BRIEF") || p.includes("SOURCE MATERIAL")) {
      const urls = [...prompt.matchAll(/<source url="([^"]+)">/g)].map((m) => m[1]);
      return {
        summary: "Northwind Robotics builds warehouse automation robots.",
        what_they_do: "Autonomous mobile robots and fleet-management software.",
        sources: urls.slice(0, 2),
      };
    }

    // Flashcards.
    if (p.includes("FLASHCARDS")) {
      return {
        flashcards: [
          { requirement_ids: ["r1"], front: "Node.js concurrency model?", back: "Single-threaded event loop." },
          { requirement_ids: ["r2"], front: "Purpose of a DB index?", back: "Faster reads, slower writes." },
        ],
      };
    }

    // Question generation — four category-specific calls. Technical covers both
    // requirements so the coverage loop finds no MUST gaps (no extra LLM call).
    if (p.includes("TECHNICAL INTERVIEW QUESTIONS") || p.includes("PRACTICAL TECHNICAL")) {
      return {
        questions: [
          { requirement_ids: ["r1"], prompt: "Explain the Node.js event loop", answer_outline: "single-threaded, microtasks", difficulty: 2 },
          { requirement_ids: ["r2"], prompt: "How does a B-tree index speed up queries?", answer_outline: "log-time lookups, write cost", difficulty: 3 },
        ],
      };
    }
    if (p.includes("BEHAVIOURAL")) {
      return {
        questions: [
          { requirement_ids: [], prompt: "Tell me about a time you owned an incident", answer_outline: "STAR", difficulty: 2 },
        ],
      };
    }
    if (p.includes("SYSTEM-DESIGN")) {
      return {
        questions: [
          { requirement_ids: ["r2"], prompt: "Design a fleet-telemetry ingestion pipeline", answer_outline: "ingest, store, query", difficulty: 3 },
        ],
      };
    }
    if (p.includes("COMPANY-FIT")) {
      return {
        questions: [
          { requirement_ids: [], prompt: "Why do you want to work at Northwind Robotics?", answer_outline: "motivation, mission fit", difficulty: 1 },
        ],
      };
    }

    // Gap generation safety net (should not be reached: no MUST gaps).
    if (p.includes("COVERAGE GAPS")) {
      return { questions: [] };
    }

    throw new Error(`fakeLlmClient: unhandled prompt starting: ${prompt.slice(0, 60)}`);
  };

  return {
    generateJson: generateJson as Pick<LlmClient, "generateJson">["generateJson"],
  };
}

/** Fake HN Algolia response for the discussion search. */
function fakeHnFetch(): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        hits: [
          {
            objectID: "1",
            title: "Northwind Robotics raises Series B",
            url: "https://news.example.com/northwind",
            points: 88,
            created_at: "2026-02-01T00:00:00Z",
          },
        ],
      }),
    }) as unknown as Response) as unknown as typeof fetch;
}

describe("runPipeline (end-to-end against a local fixture site)", () => {
  let server: Server;
  let baseUrl: string;
  const prevAllowPrivate = process.env.ALLOW_PRIVATE_HOSTS;

  beforeAll(async () => {
    // Allow crawling 127.0.0.1 (SSRF guard blocks private hosts by default).
    process.env.ALLOW_PRIVATE_HOSTS = "true";
    ({ server, baseUrl } = await startFixtureServer());
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    if (prevAllowPrivate === undefined) delete process.env.ALLOW_PRIVATE_HOSTS;
    else process.env.ALLOW_PRIVATE_HOSTS = prevAllowPrivate;
  });

  it("produces a valid CoreKit from the fixture site with all sections populated", async () => {
    const client = fakeLlmClient();

    // Wire real stage functions but inject the fake LLM client / fake HN fetch.
    // crawlSite runs for real against the local server (delay disabled).
    const deps: RunPipelineDeps = {
      extractRequirements: (jd) => extractRequirements(jd, { client }),
      crawlSite: (startUrl) => crawlSite(startUrl, { delayMs: 0 }),
      searchPublicDiscussion: (company, role) =>
        searchPublicDiscussion(company, role, { fetchImpl: fakeHnFetch() }),
      generateCompanyBrief: (input) => generateCompanyBrief(input, { client }),
      generateAllQuestions: (input) => generateAllQuestions(input, { client }),
      generateFlashcards: (input) => generateFlashcards(input, { client }),
      now: () => new Date("2026-09-22T00:00:00.000Z"),
    };

    const kit = await runPipeline(
      {
        jd: "Senior Backend Engineer at Northwind Robotics. Requires strong TypeScript/Node.js and PostgreSQL. Design reliable distributed fleet services.",
        company_url: baseUrl,
        role: "Senior Backend Engineer",
        location: "Remote",
        days: 5,
      },
      deps,
    );

    // 3. Every section populated.
    expect(kit.role.requirements.length).toBeGreaterThan(0);
    expect(kit.company_brief.summary).toMatch(/northwind/i);
    expect(kit.company_brief.what_they_do.length).toBeGreaterThan(0);

    // pages_used contains the pages actually fetched from the fixture server.
    expect(kit.source.pages_used.length).toBeGreaterThanOrEqual(2);
    expect(kit.source.pages_used.every((u) => u.startsWith(baseUrl))).toBe(true);
    // The crawl should have reached careers + engineering (linked from home).
    expect(kit.source.pages_used.some((u) => u.includes("careers"))).toBe(true);
    expect(kit.source.pages_used.some((u) => u.includes("engineering"))).toBe(true);

    expect(kit.questions.length).toBeGreaterThan(0);
    expect(kit.flashcards.length).toBeGreaterThan(0);

    // coverage exists and is honest.
    expect(kit.coverage).toBeDefined();
    expect(Number.isInteger(kit.coverage.passes)).toBe(true);
    expect(Array.isArray(kit.coverage.uncovered_requirement_ids)).toBe(true);

    // schedule exists with exactly `days` buckets.
    expect(kit.schedule.days_available).toBe(5);
    expect(kit.schedule.days).toHaveLength(5);

    // 4. Final kit passes full validation.
    const validation = validateKit(kit);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
  });
});
