import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp } from "../app.js";
import { signJwt, verifyJwt } from "../auth/jwt.js";
import type { AuthDeps } from "../auth/authService.js";
import type { KitRecord, KitRepository } from "./kitRoutes.js";
import type { StoredKit, StoredQuestion, StoredFlashcard } from "../schema/kit.js";

const SECRET = "kit-practice-test-secret";

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

function makeStoredKit(
  questions: StoredQuestion[] = [],
  flashcards: StoredFlashcard[] = [],
): StoredKit {
  return {
    source: {
      company: "Acme Corp",
      company_url: "https://acme.example.com",
      role: "Fullstack Engineer",
      location: "Remote",
      jd_chars: 120,
      researched_at: new Date().toISOString(),
      pages_used: [],
    },
    company_brief: { summary: "Brief", what_they_do: "Products", sources: [] },
    role: { title: "Fullstack Engineer", seniority: "Senior", responsibilities: [], requirements: [] },
    questions,
    flashcards,
    schedule: { days_available: 3, days: [] },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
  };
}

describe("Practice Mode Backend API (GET /kits/:id/practice)", () => {
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

  const getPractice = (path: string, token?: string) =>
    fetch(`${base}${path}`, {
      method: "GET",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });

  // 1. Authenticated practice request
  describe("authenticated practice request", () => {
    it("rejects unauthenticated request with 401", async () => {
      const res = await getPractice("/kits/k1/practice");
      expect(res.status).toBe(401);
    });

    it("rejects invalid token with 401", async () => {
      const res = await getPractice("/kits/k1/practice", "invalid.jwt.token");
      expect(res.status).toBe(401);
    });

    it("succeeds with 200 and returns practice items with complete metadata", async () => {
      const kit = await repo.create({
        userId: "user-alpha",
        title: "Alpha Kit",
        input: { jd: "Senior dev", company_url: "https://acme.example.com", days: 7 },
        inputHash: "hash-alpha",
      });

      const q1: StoredQuestion = {
        id: "q-1",
        prompt: "Explain event loop in Node.js",
        answer_outline: "Call stack, libuv, task queues",
        category: "technical",
        difficulty: 2,
        requirement_ids: ["req-node"],
        origin: "generated",
        edited: false,
        pinned: true,
        order: 0,
      };

      const f1: StoredFlashcard = {
        id: "fc-1",
        front: "What is idempotency?",
        back: "An operation that produces the same result when executed multiple times",
        requirement_ids: ["req-api"],
        origin: "generated",
        edited: false,
        pinned: false,
        order: 0,
      };

      await repo.setKitForUser(kit.id, "user-alpha", makeStoredKit([q1], [f1]));

      const res = await getPractice(`/kits/${kit.id}/practice`, tokenFor("user-alpha"));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.kitId).toBe(kit.id);
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items).toHaveLength(2);

      // Verify question metadata
      const questionItem = body.items.find((item: { id: string }) => item.id === "q-1");
      expect(questionItem).toBeDefined();
      expect(questionItem.id).toBe("q-1");
      expect(questionItem.type).toBe("question");
      expect(questionItem.content).toBe("Explain event loop in Node.js");
      expect(questionItem.difficulty).toBe(2);
      expect(questionItem.confidence).toBeNull();
      expect(questionItem.seen).toBe(false);
      expect(questionItem.section).toBe("technical");
      expect(questionItem.requirement_ids).toEqual(["req-node"]);

      // Verify flashcard metadata
      const flashcardItem = body.items.find((item: { id: string }) => item.id === "fc-1");
      expect(flashcardItem).toBeDefined();
      expect(flashcardItem.id).toBe("fc-1");
      expect(flashcardItem.type).toBe("flashcard");
      expect(flashcardItem.content).toBe("What is idempotency?");
      expect(flashcardItem.difficulty).toBeDefined();
      expect(flashcardItem.confidence).toBeNull();
      expect(flashcardItem.seen).toBe(false);
      expect(flashcardItem.section).toBeDefined();
      expect(flashcardItem.requirement_ids).toEqual(["req-api"]);
    });
  });

  // 2. Ownership protection
  describe("ownership protection", () => {
    it("returns 404 when user attempts to access another user's kit", async () => {
      const kit = await repo.create({
        userId: "owner-user",
        title: "Private Kit",
        input: { jd: "Dev", company_url: "https://acme.example.com", days: 3 },
        inputHash: "hash-private",
      });
      await repo.setKitForUser(kit.id, "owner-user", makeStoredKit());

      // Attacker tries to read owner's kit
      const res = await getPractice(`/kits/${kit.id}/practice`, tokenFor("other-user"));
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.code).toBe("not_found");
    });

    it("returns 404 for nonexistent kit id", async () => {
      const res = await getPractice("/kits/nonexistent-id/practice", tokenFor("any-user"));
      expect(res.status).toBe(404);
    });
  });

  // 3. Unseen ordering
  describe("unseen ordering", () => {
    it("orders unseen items before seen items", async () => {
      const kit = await repo.create({
        userId: "user-sort",
        title: "Sorting Kit",
        input: { jd: "Dev", company_url: "https://acme.example.com", days: 3 },
        inputHash: "hash-sort-1",
      });

      // q_seen_1: seen (confidence = 2)
      const q_seen_1: StoredQuestion & { seen?: boolean; confidence?: number } = {
        id: "q-seen-1",
        prompt: "Seen Question 1",
        answer_outline: "Outline",
        category: "technical",
        difficulty: 2,
        requirement_ids: [],
        origin: "generated",
        edited: false,
        pinned: false,
        order: 0,
        seen: true,
        confidence: 2,
      };

      // q_unseen_1: unseen
      const q_unseen_1: StoredQuestion & { seen?: boolean } = {
        id: "q-unseen-1",
        prompt: "Unseen Question 1",
        answer_outline: "Outline",
        category: "technical",
        difficulty: 1,
        requirement_ids: [],
        origin: "generated",
        edited: false,
        pinned: false,
        order: 1,
        seen: false,
      };

      // fc_seen: seen flashcard
      const fc_seen: StoredFlashcard & { seen?: boolean; confidence?: number } = {
        id: "fc-seen",
        front: "Seen Flashcard",
        back: "Back",
        requirement_ids: [],
        origin: "generated",
        edited: false,
        pinned: false,
        order: 0,
        seen: true,
        confidence: 3,
      };

      // fc_unseen: unseen flashcard
      const fc_unseen: StoredFlashcard & { seen?: boolean } = {
        id: "fc-unseen",
        front: "Unseen Flashcard",
        back: "Back",
        requirement_ids: [],
        origin: "generated",
        edited: false,
        pinned: false,
        order: 1,
        seen: false,
      };

      await repo.setKitForUser(
        kit.id,
        "user-sort",
        makeStoredKit([q_seen_1, q_unseen_1], [fc_seen, fc_unseen]),
      );

      const res = await getPractice(`/kits/${kit.id}/practice`, tokenFor("user-sort"));
      expect(res.status).toBe(200);

      const body = await res.json();
      const items = body.items;

      // The first two items must be unseen
      expect(items[0].seen).toBe(false);
      expect(items[1].seen).toBe(false);

      // The last two items must be seen
      expect(items[2].seen).toBe(true);
      expect(items[3].seen).toBe(true);

      // Check IDs match unseen set first
      const firstTwoIds = [items[0].id, items[1].id].sort();
      expect(firstTwoIds).toEqual(["fc-unseen", "q-unseen-1"]);
    });
  });

  // 4. Confidence ordering
  describe("confidence ordering", () => {
    it("orders lower confidence items before higher confidence items", async () => {
      const kit = await repo.create({
        userId: "user-conf",
        title: "Confidence Kit",
        input: { jd: "Dev", company_url: "https://acme.example.com", days: 3 },
        inputHash: "hash-conf",
      });

      const q_conf5: StoredQuestion & { seen?: boolean; confidence?: number } = {
        id: "q-conf-5",
        prompt: "High Confidence Question",
        answer_outline: "Outline",
        category: "technical",
        difficulty: 3,
        requirement_ids: [],
        origin: "generated",
        edited: false,
        pinned: false,
        order: 0,
        seen: true,
        confidence: 5,
      };

      const q_conf1: StoredQuestion & { seen?: boolean; confidence?: number } = {
        id: "q-conf-1",
        prompt: "Low Confidence Question",
        answer_outline: "Outline",
        category: "technical",
        difficulty: 1,
        requirement_ids: [],
        origin: "generated",
        edited: false,
        pinned: false,
        order: 1,
        seen: true,
        confidence: 1,
      };

      const q_conf3: StoredQuestion & { seen?: boolean; confidence?: number } = {
        id: "q-conf-3",
        prompt: "Medium Confidence Question",
        answer_outline: "Outline",
        category: "technical",
        difficulty: 2,
        requirement_ids: [],
        origin: "generated",
        edited: false,
        pinned: false,
        order: 2,
        seen: true,
        confidence: 3,
      };

      await repo.setKitForUser(
        kit.id,
        "user-conf",
        makeStoredKit([q_conf5, q_conf1, q_conf3], []),
      );

      const res = await getPractice(`/kits/${kit.id}/practice`, tokenFor("user-conf"));
      expect(res.status).toBe(200);

      const body = await res.json();
      const itemIds = body.items.map((it: { id: string }) => it.id);

      // Low confidence (1) -> Medium (3) -> High (5)
      expect(itemIds).toEqual(["q-conf-1", "q-conf-3", "q-conf-5"]);
    });
  });

  // 5. Empty practice set
  describe("empty practice set", () => {
    it("returns 200 with empty items array when kit has no questions and no flashcards", async () => {
      const kit = await repo.create({
        userId: "user-empty",
        title: "Empty Kit",
        input: { jd: "Dev", company_url: "https://acme.example.com", days: 3 },
        inputHash: "hash-empty-1",
      });

      await repo.setKitForUser(kit.id, "user-empty", makeStoredKit([], []));

      const res = await getPractice(`/kits/${kit.id}/practice`, tokenFor("user-empty"));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.kitId).toBe(kit.id);
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("returns 200 with empty items array when kit content is null/queued", async () => {
      const kit = await repo.create({
        userId: "user-empty-2",
        title: "Pending Kit",
        input: { jd: "Dev", company_url: "https://acme.example.com", days: 3 },
        inputHash: "hash-empty-2",
      });
      // kit is null (status queued)

      const res = await getPractice(`/kits/${kit.id}/practice`, tokenFor("user-empty-2"));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });
  });
});
