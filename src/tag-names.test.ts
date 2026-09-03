import { describe, expect, it } from "vitest";

import { applyConversationTags, parseDirectives, resolveTagNames } from "./inbox.js";

const vocab = (...names: string[]) =>
  new Map(names.map((n) => [n.toLowerCase(), { name: n }]));

describe("resolveTagNames", () => {
  it("keeps a tag name that contains commas intact", () => {
    const known = vocab("How to-s (save, invest, etc.)", "Investment Inquiry");
    expect(resolveTagNames(["How to-s (save, invest, etc.)"], known)).toEqual([
      "How to-s (save, invest, etc.)",
    ]);
  });

  it("still splits a plain comma list of separate tags", () => {
    const known = vocab("billing", "refund");
    expect(resolveTagNames(["billing, refund"], known)).toEqual(["billing", "refund"]);
  });

  it("recovers a comma-bearing name sharing a directive with another tag", () => {
    const known = vocab("How to-s (save, invest, etc.)", "Investment Inquiry");
    expect(
      resolveTagNames(["Investment Inquiry, How to-s (save, invest, etc.)"], known),
    ).toEqual(["Investment Inquiry", "How to-s (save, invest, etc.)"]);
  });

  it("falls back to splitting when nothing matches the vocabulary", () => {
    expect(resolveTagNames(["alpha, beta"], vocab())).toEqual(["alpha", "beta"]);
  });

  it("de-duplicates case-insensitively across directives", () => {
    const known = vocab("Fraud");
    expect(resolveTagNames(["Fraud", "fraud"], known)).toEqual(["Fraud"]);
  });
});

describe("parseDirectives tagLists", () => {
  it("preserves the raw directive body alongside the naive split", () => {
    const d = parseDirectives("Hi\n[[tag: How to-s (save, invest, etc.)]]");
    expect(d.tagLists).toEqual(["How to-s (save, invest, etc.)"]);
    expect(d.text).toBe("Hi");
  });

  it("records one entry per directive", () => {
    const d = parseDirectives("[[tag: a]]\n[[tag: b, c]]");
    expect(d.tagLists).toEqual(["a", "b, c"]);
  });
});

describe("applyConversationTags", () => {
  const makeClient = (names: string[]) => {
    const tagged: string[] = [];
    const created: string[] = [];
    return {
      tagged,
      created,
      listTags: async () => names.map((n, i) => ({ id: String(i + 1), name: n })),
      createTag: async (name: string) => {
        created.push(name);
        names.push(name);
        return { id: String(names.length), name };
      },
      tagConversation: async (_c: string, id: string, _a: string) => {
        tagged.push(id);
      },
    } as never as Parameters<typeof applyConversationTags>[0] & {
      tagged: string[];
      created: string[];
    };
  };

  it("does not shred a comma-bearing tag into new bogus tags", async () => {
    const client = makeClient(["How to-s (save, invest, etc.)"]);
    const applied = await applyConversationTags(
      client,
      "c1",
      "a1",
      ["How to-s (save, invest, etc.)"],
      true,
    );
    expect(applied).toEqual(["How to-s (save, invest, etc.)"]);
    expect(client.created).toEqual([]);
  });

  it("warns and skips unknown names when creation is off", async () => {
    const client = makeClient(["Fraud"]);
    const warnings: string[] = [];
    const applied = await applyConversationTags(
      client,
      "c1",
      "a1",
      ["Fraud, Made Up Tag"],
      false,
      { warn: (m) => warnings.push(m) },
    );
    expect(applied).toEqual(["Fraud"]);
    expect(warnings.join(" ")).toContain("Made Up Tag");
  });
});
