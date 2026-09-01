import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IntercomDedupeStore } from "./dedupe.js";
import { IntercomInbox } from "./inbox.js";
import type { IntercomClient } from "./client.js";
import type { IntercomConversation } from "./types.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string;
let dedupe: IntercomDedupeStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "intercom-conc-"));
  dedupe = new IntercomDedupeStore(path.join(dir, "dedupe.json"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function conversation(id: string): IntercomConversation {
  return {
    id,
    admin_assignee_id: "admin-1",
    source: {
      id: `src-${id}`,
      body: `hello from ${id}`,
      author: { type: "user", id: `user-${id}`, name: "Ada" },
    },
  } as unknown as IntercomConversation;
}

/** Client stub whose search returns `count` open conversations. */
function stubClient(count: number): IntercomClient {
  const conversations = Array.from({ length: count }, (_, i) => conversation(`c${i}`));
  return {
    searchAssignedConversations: async () => conversations,
    searchUnassignedConversations: async () => [],
    getConversation: async (id: string) => conversation(id),
    assign: async () => ({}) as IntercomConversation,
  } as unknown as IntercomClient;
}

describe("bounded conversation concurrency", () => {
  it("never works on more conversations at once than the configured limit", async () => {
    let active = 0;
    let peak = 0;
    const inbox = new IntercomInbox(
      stubClient(20),
      "admin-1",
      dedupe,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await wait(5);
        active -= 1;
      },
      silentLogger,
      false,
      4,
    );

    await inbox.pollOnce();

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // actually ran in parallel
  });

  it("processes every conversation exactly once", async () => {
    const handled: string[] = [];
    const inbox = new IntercomInbox(
      stubClient(12),
      "admin-1",
      dedupe,
      async (message) => {
        await wait(1);
        handled.push(message.conversationId);
      },
      silentLogger,
      false,
      5,
    );

    await inbox.pollOnce();

    expect(handled).toHaveLength(12);
    expect(new Set(handled).size).toBe(12);
  });

  it("finishes one conversation before that worker starts another", async () => {
    // With a single worker the sequence must be strictly start/finish pairs:
    // no conversation may begin while another is still open.
    const events: string[] = [];
    const inbox = new IntercomInbox(
      stubClient(4),
      "admin-1",
      dedupe,
      async (message) => {
        events.push(`start:${message.conversationId}`);
        await wait(3);
        events.push(`done:${message.conversationId}`);
      },
      silentLogger,
      false,
      1,
    );

    await inbox.pollOnce();

    for (let i = 0; i < events.length; i += 2) {
      const id = events[i].split(":")[1];
      expect(events[i]).toBe(`start:${id}`);
      expect(events[i + 1]).toBe(`done:${id}`);
    }
  });

  it("does not let two workers touch the same conversation", async () => {
    const inbox = new IntercomInbox(
      stubClient(1),
      "admin-1",
      dedupe,
      async () => {
        await wait(20);
      },
      silentLogger,
      false,
      5,
    );

    // Simulate a webhook arriving for the conversation a poll is already on.
    const poll = inbox.pollOnce();
    await wait(5);
    const concurrent = await inbox.withConversationLock("c0", async () => "ran");

    expect(concurrent).toBe(false); // rejected while in flight
    await poll;
    expect(inbox.activeConversations).toBe(0); // lock released
  });

  it("keeps going when one conversation throws", async () => {
    const handled: string[] = [];
    const inbox = new IntercomInbox(
      stubClient(6),
      "admin-1",
      dedupe,
      async (message) => {
        if (message.conversationId === "c3") throw new Error("boom");
        handled.push(message.conversationId);
      },
      silentLogger,
      false,
      2,
    );

    await expect(inbox.pollOnce()).resolves.toBeUndefined();
    expect(handled).toHaveLength(5);
    expect(handled).not.toContain("c3");
  });
});
