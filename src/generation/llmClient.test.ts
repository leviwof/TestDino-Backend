import { describe, it, expect, vi } from "vitest";
import {
  createLlmClient,
  defaultTransport,
  describeLlmConfig,
  formatLlmConfigReport,
  LlmError,
  LlmHttpError,
  LlmJsonParseError,
  type LlmClientConfig,
} from "./llmClient.js";

const config: LlmClientConfig = {
  provider: "test",
  apiKey: "k",
  model: "test-model",
  maxConcurrency: 4,
  minIntervalMs: 0,
};

describe("createLlmClient.generateJson", () => {
  it("parses valid JSON returned by the transport", async () => {
    const transport = vi.fn(async () => '{"answer": 42, "ok": true}');
    const client = createLlmClient(config, { transport });

    const result = await client.generateJson<{ answer: number; ok: boolean }>(
      "prompt",
    );

    expect(result).toEqual({ answer: 42, ok: true });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("throws LlmJsonParseError on invalid JSON (never returns malformed data)", async () => {
    // Both the original and the single repair attempt return invalid JSON.
    const transport = vi.fn(async () => "not json at all");
    const client = createLlmClient(config, { transport });

    await expect(client.generateJson("prompt")).rejects.toBeInstanceOf(
      LlmJsonParseError,
    );
  });

  it("repairs invalid JSON with exactly one repair call, then returns parsed JSON", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce("here you go: {answer: 42}") // invalid
      .mockResolvedValueOnce('{"answer": 42}'); // repaired, valid
    const client = createLlmClient(config, { transport });

    const result = await client.generateJson<{ answer: number }>("prompt");

    expect(result).toEqual({ answer: 42 });
    // One original call + exactly one repair call.
    expect(transport).toHaveBeenCalledTimes(2);
    const repairPrompt = transport.mock.calls[1][0].prompt as string;
    expect(repairPrompt).toContain("Return valid JSON only");
    expect(repairPrompt).toContain("{answer: 42}"); // original invalid response included
  });

  it("fails cleanly after a single failed repair attempt", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce("totally not json") // invalid
      .mockResolvedValueOnce("still not json"); // repair also invalid
    const client = createLlmClient(config, { transport });

    await expect(client.generateJson("prompt")).rejects.toBeInstanceOf(
      LlmJsonParseError,
    );
    // Original + exactly one repair — no further attempts.
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe("defaultTransport auth guard", () => {
  it("throws a clear error (not HTTP 401) when the API key is missing for openai", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      defaultTransport({ prompt: "p", provider: "openai", model: "gpt-4o-mini" }),
    ).rejects.toBeInstanceOf(LlmError);
    await expect(
      defaultTransport({ prompt: "p", provider: "openai", apiKey: "", model: "gpt-4o-mini" }),
    ).rejects.toThrow(/LLM_API_KEY is missing or empty/);

    // Never even attempts the network call without a key.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("throws a clear error when the API key is missing for anthropic", async () => {
    await expect(
      defaultTransport({ prompt: "p", provider: "anthropic", model: "claude-x" }),
    ).rejects.toThrow(/anthropic/);
  });
});

describe("defaultTransport non-2xx error detail", () => {
  it("surfaces the provider error body (message/type/code) while keeping the status", async () => {
    const body = JSON.stringify({
      error: {
        message: "Rate limit reached for gpt-4o-mini",
        type: "requests",
        code: "rate_limit_exceeded",
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers(),
      text: async () => body,
    } as unknown as Response);

    const err = await defaultTransport({
      prompt: "p",
      provider: "openai",
      apiKey: "k",
      model: "gpt-4o-mini",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(LlmHttpError);
    expect((err as LlmHttpError).status).toBe(429);
    expect((err as LlmHttpError).message).toContain("HTTP 429");
    expect((err as LlmHttpError).message).toContain("Rate limit reached for gpt-4o-mini");
    expect((err as LlmHttpError).message).toContain("rate_limit_exceeded");
    // Raw body is still preserved for callers that want it.
    expect((err as LlmHttpError).body).toBe(body);

    fetchSpy.mockRestore();
  });
});

describe("mock provider (development/test only)", () => {
  it("makes no network call and needs no API key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const raw = await defaultTransport({
      prompt: "JOB DESCRIPTION:\nSome role",
      provider: "mock",
      model: "irrelevant",
    });

    expect(() => JSON.parse(raw)).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns deterministic JSON matching each stage's schema", async () => {
    const call = (prompt: string) =>
      defaultTransport({ prompt, provider: "mock", model: "m" });

    // Requirement extraction.
    const req = JSON.parse(await call("JOB DESCRIPTION:\nBuild things"));
    expect(req).toMatchObject({
      title: expect.any(String),
      seniority: expect.any(String),
      responsibilities: expect.any(Array),
    });
    expect(req.requirements[0]).toMatchObject({
      text: expect.any(String),
      kind: expect.any(String),
      priority: expect.any(String),
    });

    // Company brief cites only URLs present in the prompt.
    const brief = JSON.parse(
      await call(
        'SOURCE MATERIAL:\n<source url="https://a.example">x</source>',
      ),
    );
    expect(brief.sources).toEqual(["https://a.example"]);

    // Category questions reference a requirement id from the prompt.
    const q = JSON.parse(
      await call("Generate TECHNICAL INTERVIEW QUESTIONS\n- r1 [technical/must]: x"),
    );
    expect(q.questions[0]).toMatchObject({
      requirement_ids: ["r1"],
      prompt: expect.any(String),
      answer_outline: expect.any(String),
      difficulty: 2,
    });

    // Gap questions carry a category field.
    const gap = JSON.parse(
      await call("You are filling COVERAGE GAPS\n- r2 [technical/must]: y"),
    );
    expect(gap.questions[0]).toMatchObject({
      requirement_ids: ["r2"],
      category: "technical",
    });

    // Flashcards reference a requirement id.
    const cards = JSON.parse(
      await call("Create FLASHCARDS\n- r1: x"),
    );
    expect(cards.flashcards[0]).toMatchObject({
      requirement_ids: ["r1"],
      front: expect.any(String),
      back: expect.any(String),
    });
  });

  it("is identical across calls (deterministic)", async () => {
    const p = "Generate BEHAVIOURAL INTERVIEW QUESTIONS\n- r1 [behavioural/must]: x";
    const a = await defaultTransport({ prompt: p, provider: "mock", model: "m" });
    const b = await defaultTransport({ prompt: p, provider: "mock", model: "m" });
    expect(a).toBe(b);
  });

  it("is refused in production", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(
        defaultTransport({ prompt: "JOB DESCRIPTION:", provider: "mock", model: "m" }),
      ).rejects.toBeInstanceOf(LlmError);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});

describe("describeLlmConfig (safe, no secrets)", () => {
  it("reports key presence and length without exposing the key", () => {
    const report = describeLlmConfig({
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-secret-123",
    });

    expect(report).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
      apiKeyConfigured: true,
      apiKeyLength: "sk-secret-123".length,
    });

    const text = formatLlmConfigReport(report);
    expect(text).toContain("API key configured: true");
    expect(text).toContain(`API key length: ${"sk-secret-123".length}`);
    // The secret value itself must never appear in the report.
    expect(text).not.toContain("sk-secret-123");
  });

  it("reports an absent key as not configured, length 0", () => {
    expect(describeLlmConfig({ provider: "openai", model: "m" })).toEqual({
      provider: "openai",
      model: "m",
      apiKeyConfigured: false,
      apiKeyLength: 0,
    });
  });
});

describe("OpenRouter provider support", () => {
  it("throws clear error pointing to OPENROUTER_API_KEY when key is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      defaultTransport({
        prompt: "test",
        provider: "openrouter",
        model: "openai/gpt-4o-mini",
      }),
    ).rejects.toThrow(/OPENROUTER_API_KEY is missing or empty for provider "openrouter"/);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("sends HTTP request to OpenRouter endpoint with Bearer auth and parses response", async () => {
    const mockJson = JSON.stringify({
      choices: [
        {
          message: {
            content: '{"result": "success", "score": 95}',
          },
        },
      ],
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => JSON.parse(mockJson),
    } as unknown as Response);

    const raw = await defaultTransport({
      prompt: "Give me JSON",
      provider: "openrouter",
      apiKey: "sk-or-v1-mock-key",
      model: "meta-llama/llama-3.1-8b-instruct",
    });

    expect(raw).toBe('{"result": "success", "score": 95}');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [calledUrl, calledOptions] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calledOptions.method).toBe("POST");

    const headers = calledOptions.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["authorization"]).toBe("Bearer sk-or-v1-mock-key");

    const body = JSON.parse(calledOptions.body as string);
    expect(body.model).toBe("meta-llama/llama-3.1-8b-instruct");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[1].content).toBe("Give me JSON");

    fetchSpy.mockRestore();
  });

  it("handles OpenRouter non-2xx errors with structured error details", async () => {
    const errorBody = JSON.stringify({
      error: {
        message: "Provider returned an error",
        code: 429,
        type: "insufficient_quota",
      },
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ "retry-after": "5" }),
      text: async () => errorBody,
    } as unknown as Response);

    const err = await defaultTransport({
      prompt: "p",
      provider: "openrouter",
      apiKey: "sk-or-key",
      model: "openai/gpt-4o-mini",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(LlmHttpError);
    expect((err as LlmHttpError).status).toBe(429);
    expect((err as LlmHttpError).retryAfterMs).toBe(5000);
    expect((err as LlmHttpError).message).toContain("HTTP 429");
    expect((err as LlmHttpError).message).toContain("Provider returned an error");
    expect((err as LlmHttpError).message).toContain("code: 429");

    fetchSpy.mockRestore();
  });

  it("works with createLlmClient.generateJson end-to-end with OpenRouter transport", async () => {
    const mockResponse = JSON.stringify({
      choices: [
        {
          message: {
            content: '{"questions": [{"prompt": "Explain Event Loop"}]}',
          },
        },
      ],
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => JSON.parse(mockResponse),
    } as unknown as Response);

    const client = createLlmClient({
      provider: "openrouter",
      apiKey: "sk-or-test-key",
      model: "anthropic/claude-3.5-sonnet",
      maxConcurrency: 2,
      minIntervalMs: 0,
    });

    interface ExpectedSchema {
      questions: Array<{ prompt: string }>;
    }

    const data = await client.generateJson<ExpectedSchema>("Generate questions");
    expect(data.questions[0].prompt).toBe("Explain Event Loop");

    fetchSpy.mockRestore();
  });
});

