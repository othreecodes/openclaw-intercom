/**
 * Turn the agent's plain-text reply into the HTML Intercom expects.
 *
 * Intercom's `body` is an HTML field. Posting raw text mostly works because
 * Intercom wraps blank-line-separated blocks in `<p>`, which is why paragraphs
 * have always come through — but single line breaks, bullet lists, numbered
 * steps and bold all arrive as literal characters or vanish entirely. That puts
 * the agent in a bind: the clearest answer to "how do I do X" is a numbered
 * list, and it had no way to send one.
 *
 * This is deliberately a small subset of Markdown rather than a real parser.
 * Support replies are short, the input is one model's output rather than
 * arbitrary user content, and every construct here has an obvious rendering in
 * the Messenger. Anything not listed is passed through as text.
 */

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

/** Escape the four characters that would otherwise be read as markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Inline emphasis, applied after escaping. `*` and `_` are not escaped, so the
 * markers survive and the pattern cannot match anything the escaping produced.
 */
function renderInline(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\s][^_]*)_/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

type LineKind = "bullet" | "numbered" | "text";

function classify(line: string): LineKind {
  if (BULLET.test(line)) return "bullet";
  if (NUMBERED.test(line)) return "numbered";
  return "text";
}

/**
 * Render one blank-line-delimited block.
 *
 * The block is split into consecutive runs of the same kind of line, because a
 * lead-in followed immediately by its list ("Here are the fees:" then three
 * bullets) is the most natural way to write one and the agent does it
 * constantly. Requiring a blank line before the list would silently render the
 * bullets as literal "-" characters.
 */
function renderBlock(block: string): string {
  const lines = block.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return "";

  const out: string[] = [];
  let run: string[] = [];
  let kind: LineKind | undefined;

  const flush = () => {
    if (run.length === 0 || !kind) return;
    if (kind === "text") {
      // A single newline inside a paragraph is a line break the agent meant to keep.
      out.push(`<p>${run.map(renderInline).join("<br>")}</p>`);
    } else {
      const pattern = kind === "bullet" ? BULLET : NUMBERED;
      const tag = kind === "bullet" ? "ul" : "ol";
      const items = run.map((l) => `<li>${renderInline(l.match(pattern)![1])}</li>`).join("");
      out.push(`<${tag}>${items}</${tag}>`);
    }
    run = [];
  };

  for (const line of lines) {
    const lineKind = classify(line);
    if (lineKind !== kind) {
      flush();
      kind = lineKind;
    }
    run.push(line);
  }
  flush();
  return out.join("\n");
}

/**
 * Render an agent reply as Intercom-ready HTML. Returns an empty string for
 * empty input so callers can keep skipping empty replies.
 */
export function renderReplyHtml(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";
  return normalized
    .split(/\n{2,}/)
    .map(renderBlock)
    .filter(Boolean)
    .join("\n");
}
