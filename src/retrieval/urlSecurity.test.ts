import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { validateFetchUrl, FetchUrlError } from "./urlSecurity.js";

const original = process.env.ALLOW_PRIVATE_HOSTS;
afterEach(() => {
  process.env.ALLOW_PRIVATE_HOSTS = original;
});

/** Assert validateFetchUrl rejects with a specific FetchUrlError code. */
async function expectCode(url: string, code: string) {
  await expect(validateFetchUrl(url)).rejects.toMatchObject({
    constructor: FetchUrlError,
    code,
  });
}

describe("validateFetchUrl", () => {
  it("allows a valid https URL", async () => {
    process.env.ALLOW_PRIVATE_HOSTS = "false";
    await expect(validateFetchUrl("https://example.com/page")).resolves.toBeUndefined();
  });

  it("rejects ftp protocol", async () => {
    process.env.ALLOW_PRIVATE_HOSTS = "false";
    await expectCode("ftp://example.com/file", "FETCH_PROTOCOL_NOT_ALLOWED");
  });

  it("rejects a malformed URL", async () => {
    process.env.ALLOW_PRIVATE_HOSTS = "false";
    await expectCode("not a url", "FETCH_URL_INVALID");
  });

  it("blocks localhost", async () => {
    process.env.ALLOW_PRIVATE_HOSTS = "false";
    await expectCode("http://localhost:8080/", "FETCH_PRIVATE_HOST_BLOCKED");
  });

  it("blocks a private IPv4 address", async () => {
    process.env.ALLOW_PRIVATE_HOSTS = "false";
    await expectCode("http://192.168.1.10/", "FETCH_PRIVATE_HOST_BLOCKED");
  });

  it("rejects credentials embedded in the URL", async () => {
    process.env.ALLOW_PRIVATE_HOSTS = "false";
    await expectCode("https://user:pass@example.com/", "FETCH_URL_INVALID");
  });

  it("allows private hosts when ALLOW_PRIVATE_HOSTS=true", async () => {
    process.env.ALLOW_PRIVATE_HOSTS = "true";
    await expect(validateFetchUrl("http://127.0.0.1:3000/")).resolves.toBeUndefined();
    await expect(validateFetchUrl("http://localhost:8080/")).resolves.toBeUndefined();
  });
});

describe("validateFetchUrl SSRF edge cases", () => {
  beforeEach(() => {
    process.env.ALLOW_PRIVATE_HOSTS = "false";
  });

  it("blocks IPv4-mapped IPv6 loopback", async () => {
    await expectCode("http://[::ffff:127.0.0.1]/", "FETCH_PRIVATE_HOST_BLOCKED");
  });

  it("blocks IPv4-mapped IPv6 private address", async () => {
    await expectCode("http://[::ffff:192.168.0.5]/", "FETCH_PRIVATE_HOST_BLOCKED");
  });

  it("blocks localhost aliases (case-insensitive and subdomain)", async () => {
    await expectCode("http://LOCALHOST/", "FETCH_PRIVATE_HOST_BLOCKED");
    await expectCode("http://api.localhost/", "FETCH_PRIVATE_HOST_BLOCKED");
  });

  it("blocks IPv6 loopback ::1", async () => {
    await expectCode("http://[::1]/", "FETCH_PRIVATE_HOST_BLOCKED");
  });

  it("blocks IPv4 loopback range 127.x", async () => {
    await expectCode("http://127.5.5.5/", "FETCH_PRIVATE_HOST_BLOCKED");
  });

  it("blocks IPv4 link-local 169.254.x", async () => {
    await expectCode("http://169.254.169.254/latest/meta-data", "FETCH_PRIVATE_HOST_BLOCKED");
  });

  it("blocks IPv6 link-local fe80::", async () => {
    await expectCode("http://[fe80::1]/", "FETCH_PRIVATE_HOST_BLOCKED");
  });

  it("blocks each private IPv4 range", async () => {
    await expectCode("http://10.0.0.1/", "FETCH_PRIVATE_HOST_BLOCKED");
    await expectCode("http://172.16.5.4/", "FETCH_PRIVATE_HOST_BLOCKED");
    await expectCode("http://192.168.1.1/", "FETCH_PRIVATE_HOST_BLOCKED");
    await expectCode("http://0.0.0.0/", "FETCH_PRIVATE_HOST_BLOCKED");
  });

  it("blocks private IPv6 unique-local fc00::/7", async () => {
    await expectCode("http://[fd00::1]/", "FETCH_PRIVATE_HOST_BLOCKED");
  });

  it("blocks suspicious internal hostnames", async () => {
    await expectCode("http://intranet/", "FETCH_PRIVATE_HOST_BLOCKED");
    await expectCode("http://db.internal/", "FETCH_PRIVATE_HOST_BLOCKED");
    await expectCode("http://server.lan/", "FETCH_PRIVATE_HOST_BLOCKED");
  });

  it("blocks credentials in the URL before host checks", async () => {
    await expectCode("https://admin:secret@example.com/", "FETCH_URL_INVALID");
    await expectCode("https://user@example.com/", "FETCH_URL_INVALID");
  });
});
