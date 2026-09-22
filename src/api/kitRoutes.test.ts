import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp } from "../app.js";
import { signJwt, verifyJwt } from "../auth/jwt.js";
import type { AuthDeps } from "../auth/authService.js";
import type { KitRecord, KitRepository } from "./kitRoutes.js";
import { regenerateKit, type FreshContent } from "../services/kitRegeneration.js";
import type { StoredKit, StoredQuestion, StoredFlashcard } from "../schema/kit.js";

const SECRET = "kit-route-test-secret";

/** In-memory kit store; exposes `records` so tests can seed and assert state. */
function memoryKitRepo(): KitRepository & { records: KitRecord[] } {
  const records: KitRecord[] = [];
  let seq = 0;
  return {
    records,
    async create(rec) {
      const record: KitRecord = { id: `k${++seq}`, status: "queued", kit: null, ...rec };
      records.push(record);
      return record;
    },
    async findByUserAndHash(userId, inputHash) {
      return records.find((r) => r.userId === userId && r.inputHash === inputHash) ?? null;
    },
    async findByIdForUser(id, userId) {
      return records.find((r) => r.id === id && r.userId === userId) ?? null;
    },
    async listByUser(userId) {
      return records.filter((r) => r.userId === userId);
    },
    async setKitForUser(id, userId, kit) {
      const found = records.find((r) => r.id === id && r.userId === userId);
      if (!found) return null;
      found.kit = kit;
      return found;
    },
    async deleteByIdForUser(id, userId) {
      const i = records.findIndex((r) => r.id === id && r.userId === userId);
      if (i >= 0) records.splice(i, 1);
    },
  };
}

/** Fake job creator so POST /kits does not reach the MongoDB-backed default. */
const fakeCreateJob = async (_input: { userId: string; kitId: string }) => ({
  jobId: "job-test",
  status: "queued" as const,
});

const authDeps: AuthDeps = {
  signToken: (claims, opts) => signJwt(claims, { ...opts, secret: SECRET }),
  verifyToken: (token, opts) => verifyJwt(token, { ...opts, secret: SECRET }),
};

function tokenFor(sub: string): string {
  return signJwt({ sub, email: `${sub}@example.com` }, { secret: SECRET });
}

const VALID_BODY = {
  jd: "Senior Backend Engineer. TypeScript, Node.js, PostgreSQL.",
  company_url: "https://northwind.example.com",
  days: 5,
};

// ---- StoredKit fixtures for regeneration ----

function q(
  id: string,
  prompt: string,
  flags: Partial<Pick<StoredQuestion, "origin" | "edited" | "pinned">>,
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
    order: 0,
  };
}

/** A stored kit with one of each item kind (only questions/flashcards matter). */
function seedKit(): StoredKit {
  const questions: StoredQuestion[] = [
    q("q-gen", "Stale generated question", { origin: "generated" }),
    q("q-edited", "Edited question", { origin: "generated", edited: true }),
    q("q-pinned", "Pinned question", { origin: "generated", pinned: true }),
    q("q-user", "User authored question", { origin: "user" }),
  ];
  const flashcards: StoredFlashcard[] = [
    {
      id: "f-gen",
      front: "Stale front",
      back: "Stale back",
      requirement_ids: [],
      origin: "generated",
      edited: false,
      pinned: false,
      order: 0,
    },
  ];
  return {
    source: {
      company: "Northwind",
      company_url: "https://northwind.example.com",
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

describe("Kit HTTP API — POST /kits, GET /kits/:id", () => {
  let server: Server;
  let base: string;
  let repo: ReturnType<typeof memoryKitRepo>;

  beforeEach(async () => {
    repo = memoryKitRepo();
    const app = createApp({
      authDeps,
      kitDeps: { kits: repo, createJob: fakeCreateJob, startExecution: () => {} },
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  const req = (
    method: string,
    path: string,
    { token, body }: { token?: string; body?: unknown } = {},
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("creates a kit for an authenticated user (201), owned by req.user.sub", async () => {
    const res = await req("POST", "/kits", { token: tokenFor("owner-1"), body: VALID_BODY });
    expect(res.status).toBe(201);
    expect(repo.records[0].userId).toBe("owner-1");
  });

  it("returns 400 when the body fails Zod validation", async () => {
    const res = await req("POST", "/kits", {
      token: tokenFor("owner-1"),
      body: { jd: "", company_url: "not-a-url", days: -3 },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("validation_error");
  });

  it("lets the authenticated owner fetch their kit; another user gets 404", async () => {
    const created = await (
      await req("POST", "/kits", { token: tokenFor("owner-1"), body: VALID_BODY })
    ).json();
    const id = created.kit.id;

    expect((await req("GET", `/kits/${id}`, { token: tokenFor("owner-1") })).status).toBe(200);
    expect((await req("GET", `/kits/${id}`, { token: tokenFor("intruder") })).status).toBe(404);
  });

  it("returns 401 for unauthenticated create/get", async () => {
    expect((await req("POST", "/kits", { body: VALID_BODY })).status).toBe(401);
    expect((await req("GET", "/kits/whatever")).status).toBe(401);
  });

  it("lists only the authenticated user's kits (newest data), never another user's", async () => {
    await req("POST", "/kits", { token: tokenFor("owner-1"), body: VALID_BODY });
    await req("POST", "/kits", {
      token: tokenFor("owner-1"),
      body: { ...VALID_BODY, company_url: "https://acme.example.com" },
    });
    await req("POST", "/kits", { token: tokenFor("owner-2"), body: VALID_BODY });

    const res = await req("GET", "/kits", { token: tokenFor("owner-1") });
    expect(res.status).toBe(200);
    const { kits } = await res.json();
    expect(kits).toHaveLength(2);
    expect(kits[0]).toMatchObject({ status: "queued", questionCount: 0 });
    expect(kits[0]).toHaveProperty("title");
    expect(kits[0].input.company_url).toBeDefined();
  });

  it("returns an empty list for a user with no kits, and 401 when unauthenticated", async () => {
    const res = await req("GET", "/kits", { token: tokenFor("nobody") });
    expect(res.status).toBe(200);
    expect((await res.json()).kits).toEqual([]);
    expect((await req("GET", "/kits")).status).toBe(401);
  });
});

describe("Kit HTTP API — POST /kits/:id/regenerate", () => {
  let server: Server;
  let base: string;
  let repo: ReturnType<typeof memoryKitRepo>;

  // Fresh generation includes a NEW question and a DUPLICATE of the pinned one.
  const fresh: FreshContent = {
    questions: [
      q("q-fresh", "Freshly generated question", { origin: "generated" }),
      q("q-dup", "Pinned question", { origin: "generated" }), // dupes q-pinned
    ],
    flashcards: [
      {
        id: "f-fresh",
        front: "Fresh front",
        back: "Fresh back",
        requirement_ids: [],
        origin: "generated",
        edited: false,
        pinned: false,
        order: 0,
      },
    ],
  };

  const regenerate = (kit: StoredKit) =>
    regenerateKit(kit, { generateFresh: async () => fresh });

  beforeEach(async () => {
    repo = memoryKitRepo();
    // Seed a generated kit owned by owner-1.
    repo.records.push({
      id: "k1",
      userId: "owner-1",
      title: "seed",
      input: VALID_BODY,
      inputHash: "hash-1",
      status: "done",
      kit: seedKit(),
    });
    const app = createApp({ authDeps, kitDeps: { kits: repo, regenerate } });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  const post = (path: string, token?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  it("returns 401 for an unauthenticated request", async () => {
    const res = await post("/kits/k1/regenerate");
    expect(res.status).toBe(401);
  });

  it("returns 404 when the kit belongs to another user", async () => {
    const res = await post("/kits/k1/regenerate", tokenFor("intruder"));
    expect(res.status).toBe(404);
  });

  it("lets the authenticated owner regenerate, preserving edited/pinned/user items", async () => {
    const res = await post("/kits/k1/regenerate", tokenFor("owner-1"));
    expect(res.status).toBe(200);

    const body = await res.json();
    const prompts: string[] = body.kit.questions.map((x: StoredQuestion) => x.prompt);

    // Preserved: edited, pinned, and user-authored questions survive.
    expect(prompts).toContain("Edited question");
    expect(prompts).toContain("Pinned question");
    expect(prompts).toContain("User authored question");
    // Deleted: the stale generated question is gone.
    expect(prompts).not.toContain("Stale generated question");
    // Added: the fresh generated question.
    expect(prompts).toContain("Freshly generated question");
    // Deduped: the fresh duplicate of the pinned question is NOT added twice.
    expect(prompts.filter((p) => p === "Pinned question")).toHaveLength(1);

    // Persisted back to the store.
    expect(repo.records[0].kit?.questions.some((x) => x.prompt === "Freshly generated question")).toBe(true);
  });
});
