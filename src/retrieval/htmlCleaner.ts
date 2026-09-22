/**
 * Minimal, dependency-light HTML → readable plain text cleaner.
 *
 * Strips non-content elements (script/style/noscript/iframe/svg), keeps the text
 * of headings, paragraphs and list items, normalises whitespace, and truncates
 * very large output. This is a regex-based cleaner — good enough for feeding
 * text to downstream steps, not a full HTML parser.
 */

/** Max characters of cleaned text to return. */
export const MAX_OUTPUT_CHARS = 100_000;

/** Elements whose entire contents are dropped. */
const DROP_ELEMENTS = ["script", "style", "noscript", "iframe", "svg"];

/** Elements that should produce a line break around their text. */
const BLOCK_ELEMENTS = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "li", "ul", "ol", "br", "div", "section",
  "article", "header", "footer", "tr", "table", "blockquote",
];

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)));
}

export function cleanHtml(html: string): string {
  if (!html) return "";

  let text = html;

  // Remove drop-elements including their content (case-insensitive, across lines).
  for (const tag of DROP_ELEMENTS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi");
    text = text.replace(re, " ");
    // Also drop any self-closing / unclosed leftover tags.
    text = text.replace(new RegExp(`<${tag}\\b[^>]*/?>`, "gi"), " ");
  }

  // Drop HTML comments.
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // Turn block-level tags into newlines so structure survives as line breaks.
  for (const tag of BLOCK_ELEMENTS) {
    text = text.replace(new RegExp(`</?${tag}\\b[^>]*>`, "gi"), "\n");
  }

  // Strip all remaining tags.
  text = text.replace(/<[^>]+>/g, " ");

  // Decode common entities.
  text = decodeEntities(text);

  // Normalise whitespace: collapse spaces/tabs, trim lines, drop blank lines.
  text = text
    .replace(/[ \t\f\v]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");

  // Collapse 3+ newlines to a single blank-line separator.
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  // Truncate extremely large output.
  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS).trimEnd() + "\n…[truncated]";
  }

  return text;
}
