import { describe, it, expect } from "vitest";
import { cleanHtml, MAX_OUTPUT_CHARS } from "./htmlCleaner.js";

describe("cleanHtml", () => {
  it("removes script, style, noscript, iframe and svg content", () => {
    const html = `
      <h1>Title</h1>
      <script>var x = 1; alert("no")</script>
      <style>.a{color:red}</style>
      <noscript>enable js</noscript>
      <iframe src="http://x"></iframe>
      <svg><path d="M0"/></svg>
      <p>Keep me</p>`;
    const out = cleanHtml(html);
    expect(out).toContain("Title");
    expect(out).toContain("Keep me");
    expect(out).not.toContain("alert");
    expect(out).not.toContain("color:red");
    expect(out).not.toContain("enable js");
    expect(out).not.toContain("M0");
  });

  it("preserves headings, paragraphs and list item text", () => {
    const html =
      "<h2>Requirements</h2><p>Intro para.</p><ul><li>First</li><li>Second</li></ul>";
    const out = cleanHtml(html);
    expect(out).toContain("Requirements");
    expect(out).toContain("Intro para.");
    expect(out).toContain("First");
    expect(out).toContain("Second");
  });

  it("normalizes whitespace and decodes entities", () => {
    const html = "<p>Hello&nbsp;&amp;   welcome</p>\n\n\n<p>Done</p>";
    const out = cleanHtml(html);
    expect(out).toBe("Hello & welcome\nDone");
  });

  it("truncates extremely large output", () => {
    const html = "<p>" + "a".repeat(MAX_OUTPUT_CHARS + 5000) + "</p>";
    const out = cleanHtml(html);
    expect(out.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 20);
    expect(out).toContain("[truncated]");
  });
});
