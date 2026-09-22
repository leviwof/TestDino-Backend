import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.js";

describe("Production Health Check (GET /health)", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    const app = createApp({
      dbCheck: () => ({ status: "connected" }),
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

  it("returns 200 with JSON ok status when server is running", async () => {
    const start = performance.now();
    const res = await fetch(`${base}/health`);
    const duration = performance.now() - start;

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.timestamp).toBe("string");
    expect(body.database).toBe("connected");
    expect(body.services?.database).toBe("connected");

    // Endpoint must be fast (< 1000ms to allow for loaded test runner environments)
    expect(duration).toBeLessThan(1000);
  });

  it("does not expose any secrets, credentials, or environment details", async () => {
    const res = await fetch(`${base}/health`);
    const text = await res.text();

    // Verify no secret leaks
    expect(text).not.toContain("password");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("mongodb://");
    expect(text).not.toContain("mongodb+srv://");
    expect(text).not.toContain("sk-");
    expect(text).not.toContain("token");
  });

  it("reports disconnected database status when database is not connected", async () => {
    // Create server with disconnected db check
    const disconnectedApp = createApp({
      dbCheck: () => ({ status: "disconnected" }),
    });
    const discServer = createServer(disconnectedApp);
    await new Promise<void>((resolve) => discServer.listen(0, "127.0.0.1", resolve));
    const { port } = discServer.address() as AddressInfo;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.database).toBe("disconnected");
    } finally {
      await new Promise<void>((resolve) => discServer.close(() => resolve()));
    }
  });
});
