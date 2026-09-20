import { describe, expect, it, vi } from "vitest";
import {
  createMemoryProfileWriter,
  decodeEntities,
  memoryPeerId,
  resolveMemoryProfileConfig,
} from "./memory-profile.js";

const CONFIG = { baseUrl: "https://h.test", apiKey: "k", workspace: "ws" };

/** Fake server: records calls, answers peers/list from a metadata store. */
function fakeFetch(store: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const impl = vi.fn(async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method, body });
    if (url.includes("/peers/list")) {
      const id = body?.filters?.id;
      const meta = store[id];
      return {
        ok: true,
        json: async () => ({ items: meta ? [{ id, metadata: meta }] : [] }),
      } as any;
    }
    const id = decodeURIComponent(url.split("/peers/")[1]);
    store[id] = body.metadata;
    return { ok: true, json: async () => ({}) } as any;
  });
  return { impl: impl as unknown as typeof fetch, calls, store };
}

describe("resolveMemoryProfileConfig", () => {
  const cfg = (config: unknown, enabled = true) => ({
    plugins: { entries: { "openclaw-honcho": { enabled, config } } },
  });

  it("reads the Honcho plugin config so the token is not duplicated", () => {
    expect(
      resolveMemoryProfileConfig(
        cfg({ baseUrl: "https://h.test/", apiKey: "k", workspaceId: "ws" }),
      ),
    ).toEqual(CONFIG);
  });

  it("is undefined when the plugin is disabled or unconfigured", () => {
    expect(resolveMemoryProfileConfig(cfg({ baseUrl: "b", apiKey: "k", workspaceId: "w" }, false))).toBeUndefined();
    expect(resolveMemoryProfileConfig(cfg({ baseUrl: "b", apiKey: "k" }))).toBeUndefined();
    expect(resolveMemoryProfileConfig({})).toBeUndefined();
  });
});

describe("decodeEntities", () => {
  it("decodes the escaped apostrophe Intercom really sends", () => {
    expect(decodeEntities("Akin&#39;s Alaba Ayo")).toBe("Akin's Alaba Ayo");
  });

  it("decodes named and hex entities", () => {
    expect(decodeEntities("Ben &amp; Jerry &quot;Co&quot; &lt;x&gt;")).toBe('Ben & Jerry "Co" <x>');
    expect(decodeEntities("caf&#xe9;")).toBe("caf\u00e9");
  });

  it("decodes the ampersand last, so &amp;lt; does not become a tag", () => {
    expect(decodeEntities("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
  });

  it("leaves ordinary names and unknown entities alone", () => {
    expect(decodeEntities("Esther Okonta")).toBe("Esther Okonta");
    expect(decodeEntities("A &nbsp; B")).toBe("A &nbsp; B");
  });
});

describe("createMemoryProfileWriter", () => {
  it("stores a decoded name, not the escaped one Intercom returned", async () => {
    const f = fakeFetch();
    const w = createMemoryProfileWriter({ config: CONFIG, fetchImpl: f.impl, setTimeoutImpl: () => 0 });
    w.record("6aafabe2", { name: "Akin&#39;s Alaba Ayo", channel: "Facebook" });
    await w.drain();
    expect(f.store[memoryPeerId("6aafabe2")]).toMatchObject({ name: "Akin's Alaba Ayo" });
  });

  it("writes the name under the peer id the metadata block mints", async () => {
    const f = fakeFetch();
    const w = createMemoryProfileWriter({ config: CONFIG, fetchImpl: f.impl, setTimeoutImpl: () => 0 });
    w.record("66168b", { name: "Esther Okonta", email: "e@x.com", channel: "WhatsApp" });
    await w.drain();
    expect(f.store[memoryPeerId("66168b")]).toEqual({
      contactId: "66168b",
      source: "intercom",
      name: "Esther Okonta",
      email: "e@x.com",
      channel: "WhatsApp",
    });
  });

  it("keeps the plugin own metadata keys -- a PUT replaces the whole object", async () => {
    const f = fakeFetch({
      [memoryPeerId("abc")]: { channelPeerId: "intercom-abc", autoSeeded: true },
    });
    const w = createMemoryProfileWriter({ config: CONFIG, fetchImpl: f.impl, setTimeoutImpl: () => 0 });
    w.record("abc", { name: "Paul Okoli" });
    await w.drain();
    expect(f.store[memoryPeerId("abc")]).toMatchObject({
      channelPeerId: "intercom-abc",
      autoSeeded: true,
      name: "Paul Okoli",
    });
  });

  it("rewrites after the delay, because the plugin peer-create wipes metadata", async () => {
    const f = fakeFetch();
    let fire: (() => void) | undefined;
    const w = createMemoryProfileWriter({
      config: CONFIG,
      fetchImpl: f.impl,
      setTimeoutImpl: (fn) => { fire = fn; return 1; },
    });
    w.record("abc", { name: "Esther" });
    await w.drain();
    // The plugin creates the peer and replaces metadata.
    f.store[memoryPeerId("abc")] = { channelPeerId: "intercom-abc" };
    fire?.();
    await w.drain();
    expect(f.store[memoryPeerId("abc")]).toMatchObject({ name: "Esther" });
  });

  it("debounces the follow-up so a busy conversation writes it once", () => {
    const f = fakeFetch();
    const cleared: unknown[] = [];
    let n = 0;
    const w = createMemoryProfileWriter({
      config: CONFIG,
      fetchImpl: f.impl,
      setTimeoutImpl: () => ++n,
      clearTimeoutImpl: (h) => cleared.push(h),
    });
    w.record("abc", { name: "E" });
    w.record("abc", { name: "E" });
    w.record("abc", { name: "E" });
    expect(cleared).toEqual([1, 2]);
  });

  it("spends no request on a contact with no name, email or phone", () => {
    const f = fakeFetch();
    const w = createMemoryProfileWriter({ config: CONFIG, fetchImpl: f.impl, setTimeoutImpl: () => 0 });
    w.record("abc", { channel: "WhatsApp" });
    expect(f.calls).toHaveLength(0);
  });

  it("records a WhatsApp lead that has only a display name and a phone", async () => {
    const f = fakeFetch();
    const w = createMemoryProfileWriter({ config: CONFIG, fetchImpl: f.impl, setTimeoutImpl: () => 0 });
    w.record("6aafb287", { name: "Jane", channel: "WhatsApp", phone: "+2349075350647" });
    await w.drain();
    expect(f.store[memoryPeerId("6aafb287")]).toEqual({
      contactId: "6aafb287",
      source: "intercom",
      name: "Jane",
      channel: "WhatsApp",
      phone: "+2349075350647",
    });
  });

  it("writes a phone-only contact -- no name and no email is still findable", async () => {
    const f = fakeFetch();
    const w = createMemoryProfileWriter({ config: CONFIG, fetchImpl: f.impl, setTimeoutImpl: () => 0 });
    w.record("xyz", { phone: "+2348028752077" });
    await w.drain();
    expect(f.store[memoryPeerId("xyz")]).toMatchObject({ phone: "+2348028752077" });
  });

  it("never throws or rejects when Honcho is down", async () => {
    const dead = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const warn = vi.fn();
    const w = createMemoryProfileWriter({
      config: CONFIG,
      fetchImpl: dead as unknown as typeof fetch,
      logger: { warn },
      setTimeoutImpl: () => 0,
    });
    expect(() => w.record("abc", { name: "E" })).not.toThrow();
    await expect(w.drain()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("stops scheduling once stopped", async () => {
    const f = fakeFetch();
    let fire: (() => void) | undefined;
    const w = createMemoryProfileWriter({
      config: CONFIG,
      fetchImpl: f.impl,
      setTimeoutImpl: (fn) => { fire = fn; return 1; },
    });
    w.record("abc", { name: "E" });
    await w.drain();
    const before = f.calls.length;
    w.stop();
    fire?.();
    await w.drain();
    expect(f.calls.length).toBe(before);
  });
});
