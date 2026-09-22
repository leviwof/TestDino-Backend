import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp } from "../app.js";
import { signJwt, verifyJwt } from "../auth/jwt.js";
import type { AuthDeps } from "../auth/authService.js";
import type { KitRecord, KitRepository } from "./kitRoutes.js";
import { regenerateKit, type FreshContent } from "../services/kitRegeneration.js";
import type { StoredKit, StoredQuestion } from "../schema/kit.js";

const SECRET = "kit-regen-hardening-secret";
const authDeps: AuthDeps = {
  signToken: (claims, opts) => signJwt(claims, { ...opts, secret: SECRET }),
  verifyToken: (token, opts) => verifyJwt(token, { ...opts, secret: SECRET }),
};
const tokenFor = (sub: string) => signJwt({ sub, email: `${sub}@x.com` }, { secret: SECRET });

function q(
  id: string,
  prompt: string,
  flags: Partial<Pick<StoredQuestion, "origin" | "edited" | "pinned">> = {},
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

function seedKit(): StoredKit {
  return {
    source: {
      company: "Acme",
      company_url: "https://acme.example.com",
      role: "Engineer",
      location: "Remote",
      jd_chars: 10,
      researched_at: "2026-01-01T00:00:00.000Z",
      pages_used: [],
    },
    company_brief: { summary: "", what_they_do: "", sources: [] },
    role: { title: "Engineer", seniority: "senior", responsibilities: [], requirements: [] },
    questions: [
      q("q1", "Stale generated"),
      q("q2", "Edited", { edited: true }),
      q("q3", "Pinned", { pinned: true }),
      q("q4", "User authored", { origin: "user" }),
    ],
    flashcards: [],
    schedule: { days_available: 1, days: [] },
    coverage: { uncovered_requirement_ids: [], passes: 0 },
  };
}

/** In-memory kit repo; counts setKitForUser writes so we can assert preservation. */
function memoryKitRepo(seeded: KitRecord[]) {
  const records = [...seeded];
  const state = { setKitCalls: 0 };
  const repo: KitRepository = {
    async create(rec) {
      const r: KitRecord = { id: `k${records.length + 1}`, status: "queued", kit: null, ...rec };
      records.push(r);
      return r;
    },
    async findByUserAndHash(u, h) {
      return records.find((r) => r.userId === u && r.inputHash === h) ?? null;
    },
    async findByIdForUser(id, u) {
      return records.find((r) => r.id === id && r.userId === u) ?? null;
    },
    async setKitForUser(id, u, kit) {
      state.setKitCalls += 1;
      const r = records.find((x) => x.id === id && x.userId === u);
      if (!r) return null;
      r.kit = kit;
      return r;
    },
    async deleteByIdForUser() {
      /* no-op */
    },
  };
  return { repo, records, state };
}

describe("POST /kits/:id/regenerate hardening", () => {
  let server: Server;
  let base: string;

  const startWith = async (opts: Parameters<typeof createApp>[0]) => {
    const app = createApp(opts);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  afterEach(async () => {
    if (server) await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  });

  const regen = (id: string, token?: string) =>
    fetch(`${base}/kits/${id}/regenerate`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  function seededRecord(userId = "owner-1"): KitRecord {
    return {
      id: "k1",
      userId,
      title: "seed",
      input: { jd: "x", company_url: "https://acme.example.com", days: 3 },
      inputHash: "h1",
      status: "done",
      kit: seedKit(),
    };
  }

  it("regenerates a kit for its owner, preserving edited/pinned/user items", async () => {
    const { repo, records } = memoryKitRepo([seededRecord()]);
    const fresh: FreshContent = {
      questions: [q("q5", "Fresh generated")],
      flashcards: [],
    };
    await startWith({
      authDeps,
      kitDeps: { kits: repo, regenerate: (kit) => regenerateKit(kit, { generateFresh: async () => fresh }) },
    });

    const res = await regen("k1", tokenFor("owner-1"));
    expect(res.status).toBe(200);

    const stored = records[0].kit!;
    const prompts = stored.questions.map((x) => x.prompt);
    expect(prompts).toContain("Edited");
    expect(prompts).toContain("Pinned");
    expect(prompts).toContain("User authored");
    expect(prompts).toContain("Fresh generated");
    expect(prompts).not.toContain("Stale generated");
  });

  it("only affects the authenticated user's kit (another user gets 404)", async () => {
    const { repo, state } = memoryKitRepo([seededRecord("owner-1")]);
    await startWith({
      authDeps,
      kitDeps: { kits: repo, regenerate: async (kit) => kit },
    });

    const res = await regen("k1", tokenFor("intruder"));
    expect(res.status).toBe(404);
    expect(state.setKitCalls).toBe(0); // never touched another user's kit
  });

  it("does not destroy the existing kit when regeneration fails, and marks the job", async () => {
    const { repo, records, state } = memoryKitRepo([seededRecord("owner-1")]);
    const before = JSON.stringify(records[0].kit);
    const marked: Array<{ kitId: string; userId: string }> = [];

    await startWith({
      authDeps,
      kitDeps: {
        kits: repo,
        regenerate: async () => {
          throw new Error("LLM exploded with SECRET internal detail");
        },
        markRegenerationFailed: (i) => {
          marked.push({ kitId: i.kitId, userId: i.userId });
        },
      },
    });

    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    let res: Response;
    try {
      res = await regen("k1", tokenFor("owner-1"));
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }

    // Safe failure envelope; internal detail not leaked (generic 500 in prod).
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
    expect(JSON.stringify(body)).not.toContain("SECRET internal detail");

    // Existing kit is untouched and no write happened.
    expect(state.setKitCalls).toBe(0);
    expect(JSON.stringify(records[0].kit)).toBe(before);

    // The job was marked appropriately.
    expect(marked).toEqual([{ kitId: "k1", userId: "owner-1" }]);
  });
});
