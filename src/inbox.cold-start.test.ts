import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntercomDedupeStore } from "./dedupe.js";
import { IntercomInbox } from "./inbox.js";
import type { IntercomClient } from "./client.js";
import type { IntercomConversation } from "./types.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string;
let stateFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "intercom-cold-"));
  stateFile = path.join(dir, "dedupe.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function conversation(id: string, partId: string, updatedAt = 100): IntercomConversation {
  return {
    id,
    updated_at: updatedAt,
    admin_assignee_id: "admin-1",
    source: {
      id: `src-${id}`,
      body: "original question",
      author: { type: "user", id: `u-${id}`, name: "Ada" },
    },
    conversation_parts: {
      conversation_parts: [
        { id: partId, body: `msg ${partId}`, author: { type: "user", id: `u-${id}` } },
      ],
    },
  } as unknown as IntercomConversation;
}

function harness(list: IntercomConversation[]) {
  const state = { list };
  const assign = vi.fn(async () => ({}) as IntercomConversation);
  const client = {
    searchAssignedConversations: async () => state.list,
    searchUnassignedConversations: async () => [],
    getConversation: async (id: string) => state.list.find((c) => c.id === id)!,
    assign,
  } as unknown as IntercomClient;
  return { state, client, assign };
}

function build(
  client: IntercomClient,
  onMessage: (m: { conversationId: string; partId: string }) => Promise<void>,
  opts: { replyToExisting?: boolean; store?: IntercomDedupeStore } = {},
) {
  const dedupe = opts.store ?? new IntercomDedupeStore(stateFile);
  return new IntercomInbox(
    client,
    "admin-1",
    dedupe,
    onMessage as never,
    silentLogger,
    true,
    10,
    opts.replyToExisting ?? false,
    dedupe.isFresh,
  );
}

describe("cold start backlog", () => {
  it("does not answer conversations that already existed on a first run", async () => {
    const seen: string[] = [];
    const { client } = harness([conversation("c1", "p1"), conversation("c2", "p2")]);
    const inbox = build(client, async (m) => {
      seen.push(m.partId);
    });

    await inbox.pollOnce();

    expect(seen).toEqual([]);
  });

  it("does not claim unassigned conversations while absorbing the backlog", async () => {
    const unassigned = {
      id: "u1",
      updated_at: 100,
      admin_assignee_id: 0,
      team_assignee_id: 0,
      source: { id: "s", body: "hi", author: { type: "user", id: "u" } },
    } as unknown as IntercomConversation;
    const assign = vi.fn(async () => ({}) as IntercomConversation);
    const client = {
      searchAssignedConversations: async () => [],
      searchUnassignedConversations: async () => [unassigned],
      getConversation: async () => unassigned,
      assign,
    } as unknown as IntercomClient;
    const inbox = build(client, async () => {});

    await inbox.pollOnce();

    expect(assign).not.toHaveBeenCalled();
  });

  it("answers the next new message after the backlog is absorbed", async () => {
    const seen: string[] = [];
    const { state, client } = harness([conversation("c1", "p1")]);
    const inbox = build(client, async (m) => {
      seen.push(m.partId);
    });

    await inbox.pollOnce(); // absorbs p1
    state.list = [conversation("c1", "p2", 200)];
    await inbox.pollOnce(); // p2 is genuinely new

    expect(seen).toEqual(["p2"]);
  });

  it("does not re-absorb on a later restart, so downtime messages are answered", async () => {
    const seen: string[] = [];
    const { state, client } = harness([conversation("c1", "p1")]);

    const first = build(client, async (m) => {
      seen.push(m.partId);
    });
    await first.pollOnce(); // cold start: absorb p1

    // Gateway restarts. A message arrived while it was down.
    state.list = [conversation("c1", "p-downtime", 200)];
    const restarted = build(client, async (m) => {
      seen.push(m.partId);
    });
    expect(restarted.isSeedingBacklog).toBe(false); // store is no longer fresh

    await restarted.pollOnce();

    expect(seen).toEqual(["p-downtime"]);
  });

  it("answers the backlog when replyToExistingOnStart is true", async () => {
    const seen: string[] = [];
    const { client } = harness([conversation("c1", "p1")]);
    const inbox = build(
      client,
      async (m) => {
        seen.push(m.partId);
      },
      { replyToExisting: true },
    );

    await inbox.pollOnce();

    expect(seen).toContain("p1");
  });

  it("remembers the absorbed backlog across a restart", async () => {
    const { client } = harness([conversation("c1", "p1")]);
    const first = build(client, async () => {});
    await first.pollOnce();
    first.stop();

    const store = new IntercomDedupeStore(stateFile);
    expect(store.isFresh).toBe(false);
    expect(store.isProcessed("c1", "p1")).toBe(true);
    expect(store.isProcessed("c1", "source-src-c1")).toBe(true);
  });
});
