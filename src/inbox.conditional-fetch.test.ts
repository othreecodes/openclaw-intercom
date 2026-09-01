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
let dedupe: IntercomDedupeStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "intercom-cond-"));
  dedupe = new IntercomDedupeStore(path.join(dir, "dedupe.json"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function conversation(id: string, updatedAt: number, partId = "p1"): IntercomConversation {
  return {
    id,
    updated_at: updatedAt,
    admin_assignee_id: "admin-1",
    conversation_parts: {
      conversation_parts: [
        { id: partId, body: `msg ${partId}`, author: { type: "user", id: "u1", name: "Ada" } },
      ],
    },
  } as unknown as IntercomConversation;
}

/** Search returns whatever `state.list` holds; getConversation is counted. */
function harness(initial: IntercomConversation[]) {
  const state = { list: initial };
  const getConversation = vi.fn(
    async (id: string) => state.list.find((c) => c.id === id) as IntercomConversation,
  );
  const client = {
    searchAssignedConversations: async () => state.list,
    searchUnassignedConversations: async () => [],
    getConversation,
    assign: async () => ({}) as IntercomConversation,
  } as unknown as IntercomClient;
  return { state, client, getConversation };
}

describe("conditional conversation fetch", () => {
  it("does not refetch a conversation whose updated_at has not moved", async () => {
    const { client, getConversation } = harness([conversation("c1", 100)]);
    const inbox = new IntercomInbox(client, "admin-1", dedupe, async () => {}, silentLogger, false, 4);

    await inbox.pollOnce();
    await inbox.pollOnce();
    await inbox.pollOnce();

    expect(getConversation).toHaveBeenCalledTimes(1);
  });

  it("refetches once updated_at moves", async () => {
    const { state, client, getConversation } = harness([conversation("c1", 100)]);
    const inbox = new IntercomInbox(client, "admin-1", dedupe, async () => {}, silentLogger, false, 4);

    await inbox.pollOnce();
    state.list = [conversation("c1", 200, "p2")];
    await inbox.pollOnce();

    expect(getConversation).toHaveBeenCalledTimes(2);
  });

  it("still dispatches the new message after a change", async () => {
    const seen: string[] = [];
    const { state, client } = harness([conversation("c1", 100, "p1")]);
    const inbox = new IntercomInbox(
      client,
      "admin-1",
      dedupe,
      async (m) => {
        seen.push(m.partId);
      },
      silentLogger,
      false,
      4,
    );

    await inbox.pollOnce();
    state.list = [conversation("c1", 200, "p2")];
    await inbox.pollOnce();

    expect(seen).toEqual(["p1", "p2"]);
  });

  it("retries next tick when the detail fetch itself fails", async () => {
    const conv = conversation("c1", 100);
    let attempts = 0;
    const getConversation = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("503");
      return conv;
    });
    const client = {
      searchAssignedConversations: async () => [conv],
      searchUnassignedConversations: async () => [],
      getConversation,
      assign: async () => ({}) as IntercomConversation,
    } as unknown as IntercomClient;
    const seen: string[] = [];
    const inbox = new IntercomInbox(
      client,
      "admin-1",
      dedupe,
      async (m) => {
        seen.push(m.partId);
      },
      silentLogger,
      false,
      4,
    );

    await inbox.pollOnce(); // fetch throws, watermark must not advance
    await inbox.pollOnce(); // so we try again and succeed

    expect(getConversation).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["p1"]);
  });

  it("always fetches an unassigned conversation so it can be claimed", async () => {
    const unassigned = {
      id: "u1",
      updated_at: 100,
      admin_assignee_id: 0,
      team_assignee_id: 0,
    } as unknown as IntercomConversation;
    const getConversation = vi.fn(async () => unassigned);
    const client = {
      searchAssignedConversations: async () => [],
      searchUnassignedConversations: async () => [unassigned],
      getConversation,
      assign: async () => ({}) as IntercomConversation,
    } as unknown as IntercomClient;
    const inbox = new IntercomInbox(client, "admin-1", dedupe, async () => {}, silentLogger, true, 4);

    await inbox.pollOnce();
    await inbox.pollOnce();

    expect(getConversation).toHaveBeenCalledTimes(2);
  });

  it("forgets watermarks for conversations that leave the open inbox", async () => {
    const { state, client, getConversation } = harness([
      conversation("c1", 100),
      conversation("c2", 100),
    ]);
    const inbox = new IntercomInbox(client, "admin-1", dedupe, async () => {}, silentLogger, false, 4);

    await inbox.pollOnce();
    expect(getConversation).toHaveBeenCalledTimes(2);

    // c1 closes, then reopens later at the same updated_at.
    state.list = [conversation("c2", 100)];
    await inbox.pollOnce();
    state.list = [conversation("c1", 100), conversation("c2", 100)];
    await inbox.pollOnce();

    // c1 was pruned, so it is fetched again rather than assumed unchanged.
    expect(getConversation).toHaveBeenCalledTimes(3);
  });
});
