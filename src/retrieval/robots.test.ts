import { describe, it, expect } from "vitest";
import { canFetchAccordingToRobots } from "./robots.js";

function robotsResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

const ROBOTS = "User-agent: *\nDisallow: /private";

describe("canFetchAccordingToRobots", () => {
  it("returns false for a disallowed path", async () => {
    const fetchImpl = (async () => robotsResponse(200, ROBOTS)) as unknown as typeof fetch;
    const allowed = await canFetchAccordingToRobots(
      "https://example.com/private/page",
      { fetchImpl },
    );
    expect(allowed).toBe(false);
  });

  it("returns true for an allowed path", async () => {
    const fetchImpl = (async () => robotsResponse(200, ROBOTS)) as unknown as typeof fetch;
    const allowed = await canFetchAccordingToRobots(
      "https://example.com/public/page",
      { fetchImpl },
    );
    expect(allowed).toBe(true);
  });

  it("returns true when robots.txt is unavailable (404)", async () => {
    const fetchImpl = (async () => robotsResponse(404, "")) as unknown as typeof fetch;
    const allowed = await canFetchAccordingToRobots(
      "https://example.com/private/page",
      { fetchImpl },
    );
    expect(allowed).toBe(true);
  });

  it("returns true when the request fails", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const allowed = await canFetchAccordingToRobots(
      "https://example.com/private/page",
      { fetchImpl },
    );
    expect(allowed).toBe(true);
  });
});
