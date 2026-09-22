import { describe, it, expect, vi } from "vitest";
import { searchPublicDiscussion } from "./discussions.js";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response;
}

describe("searchPublicDiscussion", () => {
  it("returns relevant results", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        hits: [
          {
            objectID: "1",
            title: "Acme raises Series B",
            url: "https://news.example.com/acme",
            points: 120,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      })) as unknown as typeof fetch;

    const out = await searchPublicDiscussion("Acme", undefined, { fetchImpl });

    expect(out.found).toBe(true);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      title: "Acme raises Series B",
      url: "https://news.example.com/acme",
      points: 120,
    });
  });

  it("incorporates role into the query when supplied", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ hits: [] })) as unknown as typeof fetch;

    await searchPublicDiscussion("Acme", "Backend Engineer", { fetchImpl });

    const calledUrl = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("Acme Backend Engineer"));
  });

  it("returns found:false with empty results when nothing is found", async () => {
    const fetchImpl = (async () => jsonResponse({ hits: [] })) as unknown as typeof fetch;

    const out = await searchPublicDiscussion("NoSuchCompanyXYZ", undefined, { fetchImpl });

    expect(out).toEqual({ found: false, results: [] });
  });

  it("handles API/network failure gracefully", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const out = await searchPublicDiscussion("Acme", undefined, { fetchImpl });

    expect(out).toEqual({ found: false, results: [] });
  });

  it("handles a non-ok API response gracefully", async () => {
    const fetchImpl = (async () => jsonResponse({}, false)) as unknown as typeof fetch;

    const out = await searchPublicDiscussion("Acme", undefined, { fetchImpl });

    expect(out).toEqual({ found: false, results: [] });
  });

  it("deduplicates URLs", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        hits: [
          { objectID: "1", title: "A", url: "https://dup.example.com/x" },
          { objectID: "2", title: "B", url: "https://dup.example.com/x" },
          { objectID: "3", title: "C", url: "https://dup.example.com/y" },
        ],
      })) as unknown as typeof fetch;

    const out = await searchPublicDiscussion("Acme", undefined, { fetchImpl });

    expect(out.results.map((r) => r.url)).toEqual([
      "https://dup.example.com/x",
      "https://dup.example.com/y",
    ]);
  });

  it("limits the number of results", async () => {
    const hits = Array.from({ length: 20 }, (_, i) => ({
      objectID: String(i),
      title: `T${i}`,
      url: `https://example.com/${i}`,
    }));
    const fetchImpl = (async () => jsonResponse({ hits })) as unknown as typeof fetch;

    const out = await searchPublicDiscussion("Acme", undefined, { fetchImpl, limit: 5 });

    expect(out.results).toHaveLength(5);
  });
});
