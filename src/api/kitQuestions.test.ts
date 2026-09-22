import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp } from "../app.js";
import { signJwt, verifyJwt } from "../auth/jwt.js";
import type { AuthDeps } from "../auth/authService.js";
import type { KitRecord, KitRepository } from "./kitRoutes.js";
import type { StoredKit, StoredQuestion } from "../schema/kit.js";

const SECRET = "kit-questions-test-secret";

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

const authDeps: AuthDeps = {
  signToken: (claims, opts) => signJwt(claims, { ...opts, secret: SECRET }),
  verifyToken: (token, opts) => verifyJwt(token, { ...opts, secret: SECRET }),
};

function tokenFor(sub: string): string {
  return signJwt({ sub, email: `${sub}@example.com` }, { secret: SECRET });
}

function makeStoredKit(questions: StoredQuestion[] = []): StoredKit {
  return {
    source: {
      company: "Acme",
      company_url: "https://acme.example.com",
      role: "Backend Engineer",
      location: "Remote",
      jd_chars: 100,
      researched_at: new Date().toISOString(),
      pages_used: [],
    },
    company_brief: { summary: "Brief", what_they_do: "Products", sources: [] },
    role: { title: "Backend Engineer", seniority: "Senior", responsibilities: [], requirements: [] },
    questions,
    flashcards: [],
    schedule: { days_available: 3, days: [] },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
  };
}

describe("Question Management Backend APIs", () => {
  let server: Server;
  let base: string;
  let repo: ReturnType<typeof memoryKitRepo>;

  beforeEach(async () => {
    repo = memoryKitRepo();
    const app = createApp({
      authDeps,
      kitDeps: { kits: repo },
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

  // ---- 1. UPDATE QUESTION ----
  describe("1. Update Question (PATCH/PUT /kits/:id/questions/:questionId)", () => {
    it("updates generated question preserving origin = generated and setting edited = true", async () => {
      const generatedQ: StoredQuestion = {
        id: "q-gen-1",
        prompt: "Original generated question prompt",
        answer_outline: "Original outline",
        category: "technical",
        difficulty: 2,
        requirement_ids: ["req-1"],
        origin: "generated",
        edited: false,
        pinned: false,
        order: 0,
      };

      const record = await repo.create({
        userId: "user-1",
        title: "Test Kit",
        input: { jd: "jd text", company_url: "https://example.com", days: 3 },
        inputHash: "hash1",
      });
      await repo.setKitForUser(record.id, "user-1", makeStoredKit([generatedQ]));

      const res = await req("PATCH", `/kits/${record.id}/questions/q-gen-1`, {
        token: tokenFor("user-1"),
        body: {
          prompt: "Updated prompt content",
          answer_outline: "Updated outline content",
          difficulty: 3,
        },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.question.id).toBe("q-gen-1");
      expect(data.question.prompt).toBe("Updated prompt content");
      expect(data.question.answer_outline).toBe("Updated outline content");
      expect(data.question.difficulty).toBe(3);
      expect(data.question.origin).toBe("generated"); // remains generated
      expect(data.question.edited).toBe(true); // marked as edited
      expect(data.question.pinned).toBe(false); // pinned preserved
    });

    it("updates user question preserving origin = user and edited = true", async () => {
      const userQ: StoredQuestion = {
        id: "q-user-1",
        prompt: "Original user question",
        answer_outline: "Initial outline",
        category: "behavioural",
        difficulty: 1,
        requirement_ids: [],
        origin: "user",
        edited: true,
        pinned: true,
        order: 1,
      };

      const record = await repo.create({
        userId: "user-1",
        title: "Test Kit",
        input: { jd: "jd", company_url: "https://example.com", days: 3 },
        inputHash: "hash2",
      });
      await repo.setKitForUser(record.id, "user-1", makeStoredKit([userQ]));

      const res = await req("PATCH", `/kits/${record.id}/questions/q-user-1`, {
        token: tokenFor("user-1"),
        body: { prompt: "Refined user prompt" },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.question.prompt).toBe("Refined user prompt");
      expect(data.question.origin).toBe("user");
      expect(data.question.edited).toBe(true);
      expect(data.question.pinned).toBe(true); // pinned preserved
    });

    it("returns 404 when questionId does not exist in kit", async () => {
      const record = await repo.create({
        userId: "user-1",
        title: "Test Kit",
        input: { jd: "jd", company_url: "https://example.com", days: 3 },
        inputHash: "hash3",
      });
      await repo.setKitForUser(record.id, "user-1", makeStoredKit([]));

      const res = await req("PATCH", `/kits/${record.id}/questions/nonexistent-id`, {
        token: tokenFor("user-1"),
        body: { prompt: "test" },
      });
      expect(res.status).toBe(404);
    });
  });

  // ---- 2. PIN / UNPIN QUESTION ----
  describe("2. Pin/Unpin Question (PATCH/POST /kits/:id/questions/:questionId/pin)", () => {
    it("pins and unpins an existing question while preserving all other metadata", async () => {
      const question: StoredQuestion = {
        id: "q-1",
        prompt: "System design question",
        answer_outline: "Outline",
        category: "system-design",
        difficulty: 3,
        requirement_ids: [],
        origin: "generated",
        edited: false,
        pinned: false,
        order: 0,
      };

      const record = await repo.create({
        userId: "user-1",
        title: "Test Kit",
        input: { jd: "jd", company_url: "https://example.com", days: 3 },
        inputHash: "hash4",
      });
      await repo.setKitForUser(record.id, "user-1", makeStoredKit([question]));

      // Pin
      const pinRes = await req("PATCH", `/kits/${record.id}/questions/q-1/pin`, {
        token: tokenFor("user-1"),
        body: { pinned: true },
      });
      expect(pinRes.status).toBe(200);
      const pinData = await pinRes.json();
      expect(pinData.question.pinned).toBe(true);
      expect(pinData.question.origin).toBe("generated");
      expect(pinData.question.prompt).toBe("System design question");

      // Unpin
      const unpinRes = await req("PATCH", `/kits/${record.id}/questions/q-1/pin`, {
        token: tokenFor("user-1"),
        body: { pinned: false },
      });
      expect(unpinRes.status).toBe(200);
      const unpinData = await unpinRes.json();
      expect(unpinData.question.pinned).toBe(false);
    });
  });

  // ---- 3. ADD USER QUESTION ----
  describe("3. Add User Question (POST /kits/:id/questions)", () => {
    it("creates a question with origin = 'user' and edited = true", async () => {
      const record = await repo.create({
        userId: "user-1",
        title: "Test Kit",
        input: { jd: "jd", company_url: "https://example.com", days: 3 },
        inputHash: "hash5",
      });
      await repo.setKitForUser(record.id, "user-1", makeStoredKit([]));

      const res = await req("POST", `/kits/${record.id}/questions`, {
        token: tokenFor("user-1"),
        body: {
          prompt: "How do you handle schema migrations with zero downtime?",
          answer_outline: "Expand and contract pattern, feature flags.",
          category: "technical",
          difficulty: 3,
        },
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.question.id).toBeDefined();
      expect(data.question.prompt).toBe("How do you handle schema migrations with zero downtime?");
      expect(data.question.answer_outline).toBe("Expand and contract pattern, feature flags.");
      expect(data.question.category).toBe("technical");
      expect(data.question.difficulty).toBe(3);
      expect(data.question.origin).toBe("user");
      expect(data.question.edited).toBe(true);
      expect(data.question.pinned).toBe(false);

      // Verify persistence in kit store
      const updatedKit = await repo.findByIdForUser(record.id, "user-1");
      expect(updatedKit?.kit?.questions).toHaveLength(1);
      expect(updatedKit?.kit?.questions[0].origin).toBe("user");
    });
  });

  // ---- 4. OWNERSHIP PROTECTION ----
  describe("4. Ownership Protection", () => {
    it("does not allow one user to update another user's kit (returns 404)", async () => {
      const question: StoredQuestion = {
        id: "q-owned",
        prompt: "Owner question",
        answer_outline: "outline",
        category: "technical",
        difficulty: 2,
        requirement_ids: [],
        origin: "generated",
        edited: false,
        pinned: false,
        order: 0,
      };

      const record = await repo.create({
        userId: "victim-user",
        title: "Victim Kit",
        input: { jd: "jd", company_url: "https://example.com", days: 3 },
        inputHash: "hash-victim",
      });
      await repo.setKitForUser(record.id, "victim-user", makeStoredKit([question]));

      // Attacker tries to modify victim's question
      const res = await req("PATCH", `/kits/${record.id}/questions/q-owned`, {
        token: tokenFor("attacker-user"),
        body: { prompt: "Tampered prompt" },
      });

      expect(res.status).toBe(404);
      // Verify victim's question was not altered
      const unmodified = await repo.findByIdForUser(record.id, "victim-user");
      expect(unmodified?.kit?.questions[0].prompt).toBe("Owner question");
    });

    it("does not allow one user to pin or add questions to another user's kit", async () => {
      const record = await repo.create({
        userId: "owner-user",
        title: "Owner Kit",
        input: { jd: "jd", company_url: "https://example.com", days: 3 },
        inputHash: "hash-owner",
      });
      await repo.setKitForUser(record.id, "owner-user", makeStoredKit([]));

      // Attacker tries to add question
      const addRes = await req("POST", `/kits/${record.id}/questions`, {
        token: tokenFor("intruder-user"),
        body: { prompt: "Injected question", category: "technical" },
      });
      expect(addRes.status).toBe(404);

      // Attacker tries to pin
      const pinRes = await req("PATCH", `/kits/${record.id}/questions/q-1/pin`, {
        token: tokenFor("intruder-user"),
        body: { pinned: true },
      });
      expect(pinRes.status).toBe(404);
    });

    it("rejects unauthenticated requests with 401", async () => {
      const res = await req("POST", "/kits/some-kit/questions", {
        body: { prompt: "test" },
      });
      expect(res.status).toBe(401);
    });
  });

  // ---- 5. VALIDATION ----
  describe("5. Validation (Zod)", () => {
    it("returns 400 when prompt is empty on add question", async () => {
      const record = await repo.create({
        userId: "user-1",
        title: "Test Kit",
        input: { jd: "jd", company_url: "https://example.com", days: 3 },
        inputHash: "hash-val-1",
      });
      await repo.setKitForUser(record.id, "user-1", makeStoredKit([]));

      const res = await req("POST", `/kits/${record.id}/questions`, {
        token: tokenFor("user-1"),
        body: { prompt: "", category: "technical" },
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("validation_error");
    });

    it("returns 400 when difficulty is invalid", async () => {
      const record = await repo.create({
        userId: "user-1",
        title: "Test Kit",
        input: { jd: "jd", company_url: "https://example.com", days: 3 },
        inputHash: "hash-val-2",
      });
      await repo.setKitForUser(record.id, "user-1", makeStoredKit([]));

      const res = await req("POST", `/kits/${record.id}/questions`, {
        token: tokenFor("user-1"),
        body: { prompt: "Valid prompt", difficulty: 5 },
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 when category is invalid", async () => {
      const record = await repo.create({
        userId: "user-1",
        title: "Test Kit",
        input: { jd: "jd", company_url: "https://example.com", days: 3 },
        inputHash: "hash-val-3",
      });
      await repo.setKitForUser(record.id, "user-1", makeStoredKit([]));

      const res = await req("POST", `/kits/${record.id}/questions`, {
        token: tokenFor("user-1"),
        body: { prompt: "Valid prompt", category: "invalid-category" },
      });

      expect(res.status).toBe(400);
    });
  });

  // ---- 4. DELETE & REORDER ----
  describe("4. Delete & reorder", () => {
    const q = (id: string, order: number): StoredQuestion => ({
      id,
      prompt: `Prompt ${id}`,
      answer_outline: "",
      category: "technical",
      difficulty: 2,
      requirement_ids: [],
      origin: "generated",
      edited: false,
      pinned: false,
      order,
    });

    it("DELETE removes a question; 404 for a missing one; owner-scoped", async () => {
      const record = await repo.create({
        userId: "user-1",
        title: "Kit",
        input: { jd: "jd", company_url: "https://example.com", days: 3 },
        inputHash: "del-hash",
      });
      await repo.setKitForUser(record.id, "user-1", makeStoredKit([q("a", 0), q("b", 1)]));

      const ok = await req("DELETE", `/kits/${record.id}/questions/a`, {
        token: tokenFor("user-1"),
      });
      expect(ok.status).toBe(200);
      const after = await repo.findByIdForUser(record.id, "user-1");
      expect(after?.kit?.questions.map((x) => x.id)).toEqual(["b"]);

      const missing = await req("DELETE", `/kits/${record.id}/questions/nope`, {
        token: tokenFor("user-1"),
      });
      expect(missing.status).toBe(404);

      const intruder = await req("DELETE", `/kits/${record.id}/questions/b`, {
        token: tokenFor("intruder"),
      });
      expect(intruder.status).toBe(404);
    });

    it("PATCH /reorder rewrites order without marking questions edited", async () => {
      const record = await repo.create({
        userId: "user-1",
        title: "Kit",
        input: { jd: "jd", company_url: "https://example.com", days: 3 },
        inputHash: "reorder-hash",
      });
      await repo.setKitForUser(
        record.id,
        "user-1",
        makeStoredKit([q("a", 0), q("b", 1), q("c", 2)]),
      );

      const res = await req("PATCH", `/kits/${record.id}/reorder`, {
        token: tokenFor("user-1"),
        body: { order: ["c", "a", "b"] },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.questions.map((x: StoredQuestion) => x.id)).toEqual(["c", "a", "b"]);
      // Reordering must not flip the edited flag.
      expect(data.questions.every((x: StoredQuestion) => x.edited === false)).toBe(true);
    });
  });

  // ---- 5. PRACTICE PROGRESS ----
  describe("5. Practice recording", () => {
    it("persists seen + confidence and reflects it in the practice feed", async () => {
      const question: StoredQuestion = {
        id: "q1",
        prompt: "What is a closure?",
        answer_outline: "",
        category: "technical",
        difficulty: 2,
        requirement_ids: [],
        origin: "generated",
        edited: false,
        pinned: false,
        order: 0,
      };
      const record = await repo.create({
        userId: "user-1",
        title: "Kit",
        input: { jd: "jd", company_url: "https://example.com", days: 3 },
        inputHash: "practice-hash",
      });
      await repo.setKitForUser(record.id, "user-1", makeStoredKit([question]));

      // Unseen to start.
      const before = await (
        await req("GET", `/kits/${record.id}/practice`, { token: tokenFor("user-1") })
      ).json();
      expect(before.items[0]).toMatchObject({ id: "q1", seen: false, confidence: null });

      // Record a confidence rating.
      const rec = await req("POST", `/kits/${record.id}/practice/q1`, {
        token: tokenFor("user-1"),
        body: { confidence: 4 },
      });
      expect(rec.status).toBe(200);
      const recData = await rec.json();
      expect(recData.practiceState).toMatchObject({ seen: true, confidence: 4 });

      // Now the feed shows it as seen with the saved confidence.
      const after = await (
        await req("GET", `/kits/${record.id}/practice`, { token: tokenFor("user-1") })
      ).json();
      const q1 = after.items.find((x: { id: string }) => x.id === "q1");
      expect(q1).toMatchObject({ seen: true, confidence: 4 });
    });

    it("rejects an out-of-range confidence and unknown items", async () => {
      const record = await repo.create({
        userId: "user-1",
        title: "Kit",
        input: { jd: "jd", company_url: "https://example.com", days: 3 },
        inputHash: "practice-hash-2",
      });
      await repo.setKitForUser(record.id, "user-1", makeStoredKit([]));

      const bad = await req("POST", `/kits/${record.id}/practice/whatever`, {
        token: tokenFor("user-1"),
        body: { confidence: 9 },
      });
      expect(bad.status).toBe(400);

      const missing = await req("POST", `/kits/${record.id}/practice/nope`, {
        token: tokenFor("user-1"),
        body: { confidence: 3 },
      });
      expect(missing.status).toBe(404);
    });
  });
});
