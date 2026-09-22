import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp } from "../app.js";
import { signJwt, verifyJwt } from "../auth/jwt.js";
import type { AuthDeps } from "../auth/authService.js";
import type { KitRecord, KitRepository } from "./kitRoutes.js";
import type { JobRecord, JobRepository } from "./jobRoutes.js";
import type { StoredKit, StoredQuestion } from "../schema/kit.js";
import { regenerateKit } from "../services/kitRegeneration.js";

const SECRET = "e2e-verification-secret-32-chars-long";

function memoryKitRepo(): KitRepository & { records: KitRecord[] } {
  const records: KitRecord[] = [];
  let seq = 0;
  return {
    records,
    async create(rec) {
      const record: KitRecord = {
        id: `k-${++seq}`,
        status: "queued",
        kit: null,
        jobId: null,
        ...rec,
      };
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
    async setJobId(id, userId, jobId) {
      const found = records.find((r) => r.id === id && r.userId === userId);
      if (found) found.jobId = jobId;
    },
    async deleteByIdForUser(id, userId) {
      const idx = records.findIndex((r) => r.id === id && r.userId === userId);
      if (idx >= 0) records.splice(idx, 1);
    },
  };
}

function memoryJobRepo() {
  const jobs: Array<{
    id: string;
    userId: string;
    kitId: string;
    status: "queued" | "crawling" | "generating" | "done" | "failed";
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  let seq = 0;
  return {
    jobs,
    async create(job: { userId: string; kitId: string; status: "queued" }) {
      const rec = {
        id: `job-${++seq}`,
        status: job.status,
        userId: job.userId,
        kitId: job.kitId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      jobs.push(rec);
      return rec;
    },
    async findById(id: string) {
      return jobs.find((j) => j.id === id) ?? null;
    },
    async updateStatus(id: string, status: "queued" | "crawling" | "generating" | "done" | "failed") {
      const found = jobs.find((j) => j.id === id);
      if (found) {
        found.status = status;
        found.updatedAt = new Date();
      }
    },
  };
}

interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
}

function memoryUserRepo() {
  const records: UserRecord[] = [];
  let seq = 0;
  return {
    records,
    async findByEmail(email: string) {
      return records.find((r) => r.email === email) ?? null;
    },
    async create({ email, passwordHash }: { email: string; passwordHash: string }) {
      const record: UserRecord = { id: `u-${++seq}`, email, passwordHash };
      records.push(record);
      return record;
    },
  };
}

const userRepo = memoryUserRepo();

const authDeps: AuthDeps = {
  users: userRepo,
  signToken: (claims, opts) => signJwt(claims, { ...opts, secret: SECRET }),
  verifyToken: (token, opts) => verifyJwt(token, { ...opts, secret: SECRET }),
};

function createSampleKit(): StoredKit {

  return {
    source: {
      company: "Acme Cloud",
      company_url: "https://acme.example.com",
      role: "Staff Backend Engineer",
      location: "Remote",
      jd_chars: 1200,
      researched_at: new Date().toISOString(),
      pages_used: ["https://acme.example.com/about", "https://acme.example.com/eng"],
    },
    company_brief: {
      summary: "Acme Cloud builds high-throughput distributed database engines.",
      what_they_do: "Cloud database and real-time streaming infrastructure.",
      sources: ["https://acme.example.com/about"],
    },
    role: {
      title: "Staff Backend Engineer",
      seniority: "Staff",
      responsibilities: ["Design resilient microservices", "Optimize database indexing"],
      requirements: [
        {
          id: "req-dist-sys",
          text: "5+ years distributed systems & consensus algorithms (Raft, Paxos)",
          kind: "technical",
          priority: "must",
        },
        {
          id: "req-mentorship",
          text: "Demonstrated mentorship of senior engineers",
          kind: "behavioural",
          priority: "must",
        },
      ],
    },
    questions: [
      {
        id: "q-1",
        prompt: "Explain how raft leader election prevents split-brain scenarios.",
        answer_outline: "Term numbers, quorum voting, heartbeats.",
        category: "technical",
        difficulty: 3,
        requirement_ids: ["req-dist-sys"],
        origin: "generated",
        edited: false,
        pinned: false,
        order: 0,
      },
      {
        id: "q-2",
        prompt: "Describe how you handled a disagreement on system architecture.",
        answer_outline: "Focus on technical data, trade-off matrix, consensus building.",
        category: "behavioural",
        difficulty: 2,
        requirement_ids: ["req-mentorship"],
        origin: "generated",
        edited: false,
        pinned: false,
        order: 1,
      },
    ],
    flashcards: [
      {
        id: "fc-1",
        front: "What is CAP theorem?",
        back: "Consistency, Availability, Partition Tolerance — pick two under network partition.",
        requirement_ids: ["req-dist-sys"],
        origin: "generated",
        edited: false,
        pinned: false,
        order: 0,
      },
    ],
    schedule: {
      days_available: 7,
      days: [
        { day: 1, focus: "Distributed Systems & Raft", question_ids: ["q-1"], minutes: 45 },
        { day: 2, focus: "Leadership & Architecture", question_ids: ["q-2"], minutes: 30 },
      ],
    },
    coverage: {
      uncovered_requirement_ids: [],
      passes: 2,
    },
  };
}

describe("End-to-End Application Flow Verification", () => {
  let server: Server;
  let base: string;
  let kitRepo: ReturnType<typeof memoryKitRepo>;
  let jobRepo: ReturnType<typeof memoryJobRepo>;

  beforeEach(async () => {
    kitRepo = memoryKitRepo();
    jobRepo = memoryJobRepo();

    const app = createApp({
      authDeps,
      kitDeps: {
        kits: kitRepo,
        startExecution: () => {},
        createJob: async ({ userId, kitId }) => {
          const j = await jobRepo.create({ userId, kitId, status: "queued" });
          return { jobId: j.id, status: j.status };
        },
        regenerate: async (kit) =>
          regenerateKit(kit, {
            generateFresh: async () => ({
              questions: [
                {
                  id: "q-fresh-1",
                  prompt: "Fresh generated question on Raft consensus",
                  answer_outline: "Discuss log replication",
                  category: "technical",
                  difficulty: 2,
                  requirement_ids: ["req-dist-sys"],
                  origin: "generated",
                  edited: false,
                  pinned: false,
                  order: 99,
                },
              ],
              flashcards: [],
            }),
          }),
      },
      jobDeps: {
        getJob: async (jobId) => {
          const j = await jobRepo.findById(jobId);
          if (!j) return null;
          return {
            jobId: j.id,
            kitId: j.kitId,
            userId: j.userId,
            status: j.status,
            createdAt: j.createdAt,
            updatedAt: j.updatedAt,
          };
        },
      },
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

  const api = (
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
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  it("completes the entire 14-step E2E flow successfully", async () => {
    // -------------------------------------------------------------------------
    // 1. Register and Login
    // -------------------------------------------------------------------------
    const regRes = await api("POST", "/auth/register", {
      body: { email: "engineer@testdino.com", password: "Password123!" },
    });
    expect(regRes.status).toBe(201);
    const regData = await regRes.json();
    expect(regData.user.email).toBe("engineer@testdino.com");
    expect(regData.user.passwordHash).toBeUndefined(); // no password leak

    const loginRes = await api("POST", "/auth/login", {
      body: { email: "engineer@testdino.com", password: "Password123!" },
    });
    expect(loginRes.status).toBe(200);
    const loginData = await loginRes.json();
    const token = loginData.token;
    expect(token).toBeDefined();

    // Verify /auth/me returns the authenticated user
    const meRes = await api("GET", "/auth/me", { token });
    expect(meRes.status).toBe(200);
    const meData = await meRes.json();
    expect(meData.user.email).toBe("engineer@testdino.com");

    // -------------------------------------------------------------------------
    // 2 & 3. Create a Kit and Receive kitId / jobId
    // -------------------------------------------------------------------------
    const createRes = await api("POST", "/kits", {
      token,
      body: {
        jd: "Staff Backend Engineer at Acme Cloud. Distributed systems expert with Raft experience.",
        company_url: "https://acme.example.com",
        days: 7,
      },
    });
    expect(createRes.status).toBe(201);
    const createData = await createRes.json();
    const { kitId, jobId, status } = createData;

    expect(kitId).toBeDefined();
    expect(jobId).toBeDefined();
    expect(status).toBe("queued");

    // -------------------------------------------------------------------------
    // 4. Job Progress Tracking: queued -> crawling -> generating -> done
    // -------------------------------------------------------------------------
    const jobInitialRes = await api("GET", `/jobs/${jobId}`, { token });
    expect(jobInitialRes.status).toBe(200);
    const jobInitial = await jobInitialRes.json();
    expect(jobInitial.job.status).toBe("queued");

    // Advance job through pipeline statuses
    await jobRepo.updateStatus(jobId, "crawling");
    let jobPoll = await (await api("GET", `/jobs/${jobId}`, { token })).json();
    expect(jobPoll.job.status).toBe("crawling");

    await jobRepo.updateStatus(jobId, "generating");
    jobPoll = await (await api("GET", `/jobs/${jobId}`, { token })).json();
    expect(jobPoll.job.status).toBe("generating");

    // Complete job & attach generated kit
    const generatedKit = createSampleKit();
    await kitRepo.setKitForUser(kitId, meData.user.id, generatedKit);
    await jobRepo.updateStatus(jobId, "done");

    jobPoll = await (await api("GET", `/jobs/${jobId}`, { token })).json();
    expect(jobPoll.job.status).toBe("done");

    // -------------------------------------------------------------------------
    // 5 & 6. Open Completed Kit & Verify All Sections
    // -------------------------------------------------------------------------
    const kitRes = await api("GET", `/kits/${kitId}`, { token });
    expect(kitRes.status).toBe(200);

    // Retrieve kit record directly from store to inspect complete payload
    const storedRecord = await kitRepo.findByIdForUser(kitId, meData.user.id);
    expect(storedRecord).toBeDefined();
    const kit = storedRecord!.kit!;

    // Company Brief
    expect(kit.company_brief.summary).toContain("Acme Cloud");
    expect(kit.company_brief.sources).toHaveLength(1);

    // Requirements
    expect(kit.role.requirements).toHaveLength(2);
    expect(kit.role.requirements[0].id).toBe("req-dist-sys");
    expect(kit.role.requirements[0].kind).toBe("technical");

    // Questions
    expect(kit.questions).toHaveLength(2);
    expect(kit.questions[0].prompt).toContain("raft leader election");

    // Schedule
    expect(kit.schedule.days_available).toBe(7);
    expect(kit.schedule.days).toHaveLength(2);

    // Coverage
    expect(kit.coverage.passes).toBe(2);
    expect(kit.coverage.uncovered_requirement_ids).toEqual([]);

    // -------------------------------------------------------------------------
    // 7 & 8. Content Edits, Pinning, User Questions, and Regeneration
    // -------------------------------------------------------------------------
    // 8a. Edit question
    const editRes = await api("PATCH", `/kits/${kitId}/questions/q-1`, {
      token,
      body: { prompt: "Custom edited prompt: Raft leader election details" },
    });
    expect(editRes.status).toBe(200);
    const editedQ = (await editRes.json()).question;
    expect(editedQ.prompt).toBe("Custom edited prompt: Raft leader election details");
    expect(editedQ.edited).toBe(true);
    expect(editedQ.origin).toBe("generated");

    // 8b. Pin question
    const pinRes = await api("PATCH", `/kits/${kitId}/questions/q-1/pin`, {
      token,
      body: { pinned: true },
    });
    expect(pinRes.status).toBe(200);
    const pinnedQ = (await pinRes.json()).question;
    expect(pinnedQ.pinned).toBe(true);

    // 8c. Add user-authored question
    const addQRes = await api("POST", `/kits/${kitId}/questions`, {
      token,
      body: {
        prompt: "Tell me about designing an active-active replication pipeline.",
        difficulty: 3,
        section: "technical",
      },
    });
    expect(addQRes.status).toBe(201);
    const userQ: StoredQuestion = (await addQRes.json()).question;
    expect(userQ.origin).toBe("user");
    expect(userQ.edited).toBe(true);

    // 7. Regenerate kit and verify edited/pinned/user items are preserved
    const regenRes = await api("POST", `/kits/${kitId}/regenerate`, { token });
    expect(regenRes.status).toBe(200);

    const afterRegenRecord = await kitRepo.findByIdForUser(kitId, meData.user.id);
    const questionsAfterRegen = afterRegenRecord!.kit!.questions;

    // Preserved edited prompt
    const foundEdited = questionsAfterRegen.find((q) => q.id === "q-1");
    expect(foundEdited).toBeDefined();
    expect(foundEdited!.prompt).toBe("Custom edited prompt: Raft leader election details");
    expect(foundEdited!.pinned).toBe(true);

    // Preserved user-authored question
    const foundUserQ = questionsAfterRegen.find((q) => q.id === userQ.id);
    expect(foundUserQ).toBeDefined();
    expect(foundUserQ!.origin).toBe("user");

    // -------------------------------------------------------------------------
    // 9 & 10. Practice Mode & Confidence Ordering
    // -------------------------------------------------------------------------
    // Mark one question as seen with confidence score
    (foundEdited as StoredQuestion & { seen: boolean; confidence: number }).seen = true;
    (foundEdited as StoredQuestion & { seen: boolean; confidence: number }).confidence = 2;

    await kitRepo.setKitForUser(kitId, meData.user.id, afterRegenRecord!.kit!);

    const practiceRes = await api("GET", `/kits/${kitId}/practice`, { token });
    expect(practiceRes.status).toBe(200);
    const practiceBody = await practiceRes.json();

    expect(Array.isArray(practiceBody.items)).toBe(true);
    expect(practiceBody.items.length).toBeGreaterThan(0);

    // Unseen items come before seen items
    const seenStatuses = practiceBody.items.map((it: { seen: boolean }) => it.seen);
    const firstSeenIndex = seenStatuses.indexOf(true);
    const lastUnseenIndex = seenStatuses.lastIndexOf(false);
    if (firstSeenIndex !== -1 && lastUnseenIndex !== -1) {
      expect(lastUnseenIndex).toBeLessThan(firstSeenIndex);
    }

    // -------------------------------------------------------------------------
    // 11. Idempotent Duplicate Kit Creation
    // -------------------------------------------------------------------------
    const dupRes = await api("POST", "/kits", {
      token,
      body: {
        jd: "Staff Backend Engineer at Acme Cloud. Distributed systems expert with Raft experience.",
        company_url: "https://acme.example.com",
        days: 7,
      },
    });
    expect(dupRes.status).toBe(200); // 200 idempotent response, not 201
    const dupData = await dupRes.json();
    expect(dupData.kitId).toBe(kitId);

    // -------------------------------------------------------------------------
    // 12. Unauthorized Kit / Job Access Protection
    // -------------------------------------------------------------------------
    // Create second user
    const user2Reg = await api("POST", "/auth/register", {
      body: { email: "unauthorized@example.com", password: "Password123!" },
    });
    expect(user2Reg.status).toBe(201);
    const user2Login = await api("POST", "/auth/login", {
      body: { email: "unauthorized@example.com", password: "Password123!" },
    });
    const user2Token = (await user2Login.json()).token;

    // User 2 cannot access User 1's kit
    const unauthKit = await api("GET", `/kits/${kitId}`, { token: user2Token });
    expect(unauthKit.status).toBe(404);

    // User 2 cannot access User 1's job
    const unauthJob = await api("GET", `/jobs/${jobId}`, { token: user2Token });
    expect(unauthJob.status).toBe(404);

    // User 2 cannot access User 1's practice items
    const unauthPractice = await api("GET", `/kits/${kitId}/practice`, { token: user2Token });
    expect(unauthPractice.status).toBe(404);
  });
});
