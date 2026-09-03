import { describe, expect, it } from "vitest";

import { renderReplyHtml } from "./render.js";

describe("renderReplyHtml", () => {
  it("wraps blank-line blocks as paragraphs", () => {
    expect(renderReplyHtml("First para.\n\nSecond para.")).toBe(
      "<p>First para.</p>\n<p>Second para.</p>",
    );
  });

  it("keeps a single newline inside a paragraph as a line break", () => {
    expect(renderReplyHtml("Line one\nLine two")).toBe("<p>Line one<br>Line two</p>");
  });

  it("renders a bullet list", () => {
    expect(renderReplyHtml("- Save\n- Invest")).toBe("<ul><li>Save</li><li>Invest</li></ul>");
  });

  it("renders numbered steps, which is the whole point for how-to answers", () => {
    expect(renderReplyHtml("1. Open the app\n2. Tap Save")).toBe(
      "<ol><li>Open the app</li><li>Tap Save</li></ol>",
    );
  });

  it("accepts 1) as well as 1. for numbering", () => {
    expect(renderReplyHtml("1) One\n2) Two")).toBe("<ol><li>One</li><li>Two</li></ol>");
  });

  it("mixes prose and a list across blocks", () => {
    expect(renderReplyHtml("Here is how:\n\n1. One\n2. Two\n\nThat is it.")).toBe(
      "<p>Here is how:</p>\n<ol><li>One</li><li>Two</li></ol>\n<p>That is it.</p>",
    );
  });

  it("renders a list that follows its lead-in without a blank line", () => {
    expect(renderReplyHtml("Here are the fees:\n- Below 50k: 25\n- Above: 50")).toBe(
      "<p>Here are the fees:</p>\n<ul><li>Below 50k: 25</li><li>Above: 50</li></ul>",
    );
  });

  it("returns to prose after a list inside the same block", () => {
    expect(renderReplyHtml("Steps:\n1. One\n2. Two\nThat is all.")).toBe(
      "<p>Steps:</p>\n<ol><li>One</li><li>Two</li></ol>\n<p>That is all.</p>",
    );
  });

  it("keeps bullets and numbers in separate lists", () => {
    expect(renderReplyHtml("- a\n1. b")).toBe("<ul><li>a</li></ul>\n<ol><li>b</li></ol>");
  });

  it("renders bold and italic", () => {
    expect(renderReplyHtml("**Free** and _instant_")).toBe(
      "<p><strong>Free</strong> and <em>instant</em></p>",
    );
  });

  it("does not italicise inside a word (snake_case survives)", () => {
    expect(renderReplyHtml("use plan_id here")).toBe("<p>use plan_id here</p>");
  });

  it("escapes HTML so a reply cannot inject markup", () => {
    expect(renderReplyHtml("5 < 10 & <script>alert(1)</script>")).toBe(
      "<p>5 &lt; 10 &amp; &lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("escapes before emphasis, so escaped output cannot be re-parsed", () => {
    expect(renderReplyHtml("**<b>hi</b>**")).toBe("<p><strong>&lt;b&gt;hi&lt;/b&gt;</strong></p>");
  });

  it("leaves a bare URL alone for Intercom to autolink", () => {
    expect(renderReplyHtml("See https://help.cowrywise.com/en/")).toBe(
      "<p>See https://help.cowrywise.com/en/</p>",
    );
  });

  it("returns an empty string for empty or whitespace-only input", () => {
    expect(renderReplyHtml("")).toBe("");
    expect(renderReplyHtml("   \n\n  ")).toBe("");
  });

  it("collapses stray blank lines rather than emitting empty paragraphs", () => {
    expect(renderReplyHtml("A\n\n\n\nB")).toBe("<p>A</p>\n<p>B</p>");
  });

  it("preserves emoji", () => {
    expect(renderReplyHtml("Hey Ada 👋")).toBe("<p>Hey Ada 👋</p>");
  });
});
