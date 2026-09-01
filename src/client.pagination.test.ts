import { describe, expect, it } from "vitest";
import { IntercomClient } from "./client.js";

interface Call {
  url: string;
  body: Record<string, unknown>;
}

/** A fetch stub that serves `pages` of conversations with Intercom-style cursors. */
function pagedFetch(pages: string[][], cursorStyle: "object" | "string" = "object") {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    const pagination = (body.pagination ?? {}) as { starting_after?: string };
    const index = pagination.starting_after ? Number(pagination.starting_after) : 0;
    const conversations = (pages[index] ?? []).map((id) => ({ id }));
    const hasNext = index + 1 < pages.length;
    const nextCursor = String(index + 1);
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        conversations,
        pages: hasNext
          ? { next: cursorStyle === "string" ? nextCursor : { starting_after: nextCursor } }
          : {},
      }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("conversation search pagination", () => {
  it("follows the cursor across pages and returns every conversation", async () => {
    const { impl, calls } = pagedFetch([["a", "b"], ["c", "d"], ["e"]]);
    const client = new IntercomClient("tok", "2.16", impl);

    const found = await client.searchAssignedConversations("admin-1");

    expect(found.map((c) => c.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(calls).toHaveLength(3);
  });

  it("requests the maximum page size and omits a cursor on the first call", async () => {
    const { impl, calls } = pagedFetch([["a"]]);
    const client = new IntercomClient("tok", "2.16", impl);

    await client.searchAssignedConversations("admin-1");

    expect(calls[0].body.pagination).toEqual({ per_page: 150 });
  });

  it("accepts a bare string cursor as well as an object", async () => {
    const { impl } = pagedFetch([["a"], ["b"]], "string");
    const client = new IntercomClient("tok", "2.16", impl);

    const found = await client.searchAssignedConversations("admin-1");

    expect(found.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("stops at maxPages instead of paging forever", async () => {
    const pages = Array.from({ length: 10 }, (_, i) => [`c${i}`]);
    const { impl, calls } = pagedFetch(pages);
    const client = new IntercomClient("tok", "2.16", impl);

    const found = await client.searchAssignedConversations("admin-1", { maxPages: 3 });

    expect(calls).toHaveLength(3);
    expect(found).toHaveLength(3);
  });

  it("paginates the unassigned search the same way", async () => {
    const { impl, calls } = pagedFetch([["u1"], ["u2"]]);
    const client = new IntercomClient("tok", "2.16", impl);

    const found = await client.searchUnassignedConversations();

    expect(found.map((c) => c.id)).toEqual(["u1", "u2"]);
    expect(calls[0].body.query).toMatchObject({
      value: [
        { field: "admin_assignee_id", operator: "=", value: 0 },
        { field: "open", operator: "=", value: true },
      ],
    });
  });

  it("stops when a page comes back empty", async () => {
    const { impl, calls } = pagedFetch([["a"], []]);
    const client = new IntercomClient("tok", "2.16", impl);

    const found = await client.searchAssignedConversations("admin-1");

    expect(found.map((c) => c.id)).toEqual(["a"]);
    expect(calls).toHaveLength(2);
  });
});
