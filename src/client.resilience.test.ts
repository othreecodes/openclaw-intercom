import { describe, expect, it, vi } from "vitest";
import { IntercomClient, IntercomApiError } from "./client.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Client with instant sleeps and fixed jitter so retries are deterministic. */
function client(fetchImpl: typeof fetch, overrides = {}) {
  return new IntercomClient("tok", "2.16", fetchImpl, {
    sleep: async () => {},
    random: () => 0.5,
    ...overrides,
  });
}

describe("request resilience", () => {
  it("retries a 429 and returns the eventual success", async () => {
    const impl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}, { "Retry-After": "1" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "a" })) as unknown as typeof fetch;

    const found = await client(impl).getConversation("a");

    expect(found).toEqual({ id: "a" });
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it.each([500, 502, 503, 504, 408])("retries a %i", async (status) => {
    const impl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(status, {}))
      .mockResolvedValueOnce(jsonResponse(200, { id: "a" })) as unknown as typeof fetch;

    await expect(client(impl).getConversation("a")).resolves.toEqual({ id: "a" });
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx that is not 429", async () => {
    const impl = vi.fn().mockResolvedValue(jsonResponse(404, { error: "nope" })) as unknown as typeof fetch;

    await expect(client(impl).getConversation("a")).rejects.toBeInstanceOf(IntercomApiError);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("retries a network failure", async () => {
    const impl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse(200, { id: "a" })) as unknown as typeof fetch;

    await expect(client(impl).getConversation("a")).resolves.toEqual({ id: "a" });
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    const impl = vi.fn().mockResolvedValue(jsonResponse(503, {})) as unknown as typeof fetch;

    await expect(client(impl, { maxAttempts: 3 }).getConversation("a")).rejects.toBeTruthy();
    expect(impl).toHaveBeenCalledTimes(3);
  });
});

describe("tag cache", () => {
  it("fetches the tag list once and reuses it", async () => {
    const impl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: [{ id: "1", name: "Break Plan" }] })) as unknown as typeof fetch;
    const c = client(impl);

    await c.listTags();
    await c.listTags();
    await c.listTags();

    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent callers into one request", async () => {
    const impl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: [] })) as unknown as typeof fetch;
    const c = client(impl);

    await Promise.all([c.listTags(), c.listTags(), c.listTags()]);

    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("refetches after the ttl expires", async () => {
    const impl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: [] })) as unknown as typeof fetch;
    const c = client(impl, { tagCacheTtlMs: 0 });

    await c.listTags();
    await c.listTags();

    expect(impl).toHaveBeenCalledTimes(2);
  });

  it("keeps a newly created tag visible without refetching", async () => {
    const impl = vi.fn(async (_url: string, init: RequestInit) =>
      init.method === "POST"
        ? jsonResponse(200, { id: "2", name: "New" })
        : jsonResponse(200, { data: [{ id: "1", name: "Old" }] }),
    ) as unknown as typeof fetch;
    const c = client(impl);

    await c.listTags();
    await c.createTag("New");
    const tags = await c.listTags();

    expect(tags.map((t) => t.name)).toEqual(["Old", "New"]);
  });

  it("drops the cache when invalidated", async () => {
    const impl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: [] })) as unknown as typeof fetch;
    const c = client(impl);

    await c.listTags();
    c.invalidateTagCache();
    await c.listTags();

    expect(impl).toHaveBeenCalledTimes(2);
  });
});
