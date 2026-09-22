import { describe, it, expect } from "vitest";
import { extractLinks } from "./linkExtractor.js";

const BASE = "https://example.com/careers/list";

describe("extractLinks", () => {
  it("keeps absolute http(s) URLs", () => {
    const html = '<a href="https://other.com/page">x</a>';
    expect(extractLinks(BASE, html)).toEqual(["https://other.com/page"]);
  });

  it("resolves root-relative URLs", () => {
    const html = '<a href="/careers">x</a>';
    expect(extractLinks(BASE, html)).toEqual(["https://example.com/careers"]);
  });

  it("resolves ../ URLs", () => {
    const html = '<a href="../about">x</a>';
    // /careers/list -> /careers/ -> ../about resolves to /about
    expect(extractLinks(BASE, html)).toEqual(["https://example.com/about"]);
  });

  it("resolves ./ URLs", () => {
    const html = '<a href="./jobs">x</a>';
    expect(extractLinks(BASE, html)).toEqual(["https://example.com/careers/jobs"]);
  });

  it("ignores mailto, tel, javascript, empty and fragment-only links", () => {
    const html = `
      <a href="mailto:a@b.com">m</a>
      <a href="tel:+123">t</a>
      <a href="javascript:void(0)">j</a>
      <a href="">e</a>
      <a href="#section">f</a>`;
    expect(extractLinks(BASE, html)).toEqual([]);
  });

  it("strips fragments but preserves query params", () => {
    const html = '<a href="/search?q=node&sort=date#top">x</a>';
    expect(extractLinks(BASE, html)).toEqual([
      "https://example.com/search?q=node&sort=date",
    ]);
  });

  it("removes duplicate URLs", () => {
    const html = `
      <a href="/careers">a</a>
      <a href="/careers">b</a>
      <a href="/careers#footer">c</a>`;
    expect(extractLinks(BASE, html)).toEqual(["https://example.com/careers"]);
  });
});
