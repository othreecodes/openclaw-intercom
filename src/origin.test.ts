import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OriginStore, originAsRoute, resolveOriginRoute } from "./origin.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "origin-test-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("OriginStore", () => {
  it("records a conversation's first-seen assignment", () => {
    const s = new OriginStore(path.join(dir, "state.json"));
    s.recordIfAbsent("c1", { teamId: "5550689" });
    expect(s.get("c1")).toEqual({ teamId: "5550689" });
  });

  it("is write-once: a later call cannot overwrite the true origin", () => {
    const s = new OriginStore(path.join(dir, "state.json"));
    s.recordIfAbsent("c1", { teamId: "5550689" }); // true origin: Socials
    s.recordIfAbsent("c1", { adminId: "5111943" }); // Sisi's own later claim
    expect(s.get("c1")).toEqual({ teamId: "5550689" });
  });

  it("records nothing for a conversation with no assignee at all", () => {
    const s = new OriginStore(path.join(dir, "state.json"));
    s.recordIfAbsent("c1", {});
    expect(s.get("c1")).toBeUndefined();
  });

  it("survives a restart via the journal", () => {
    const file = path.join(dir, "state.json");
    const a = new OriginStore(file);
    a.recordIfAbsent("c1", { teamId: "8407270" });
    const b = new OriginStore(file);
    expect(b.get("c1")).toEqual({ teamId: "8407270" });
  });

  it("survives a restart after compaction", () => {
    const file = path.join(dir, "state.json");
    const a = new OriginStore(file, undefined, { compactThreshold: 1 });
    a.recordIfAbsent("c1", { teamId: "8407270" });
    expect(fs.existsSync(`${file}.journal`)).toBe(false);
    const b = new OriginStore(file);
    expect(b.get("c1")).toEqual({ teamId: "8407270" });
  });
});

describe("originAsRoute", () => {
  it("prefers the team over an admin when both are somehow set", () => {
    expect(originAsRoute({ teamId: "T", adminId: "A" })).toEqual({ id: "T", type: "team" });
  });

  it("falls back to the admin when there is no team", () => {
    expect(originAsRoute({ adminId: "A" })).toEqual({ id: "A", type: "admin" });
  });

  it("is undefined when there is no recorded origin", () => {
    expect(originAsRoute(undefined)).toBeUndefined();
  });
});


describe("originAsRoute and non-routable admins", () => {
  it("drops an origin admin that cannot own an inbox", () => {
    // The Operator bot: assigned on paper, worked by nobody.
    expect(originAsRoute({ adminId: "1553029" }, new Set(["1553029"]))).toBeUndefined();
  });

  it("still routes a human admin", () => {
    expect(originAsRoute({ adminId: "A" }, new Set(["1553029"]))).toEqual({
      id: "A",
      type: "admin",
    });
  });

  it("prefers the team even when the admin is non-routable", () => {
    expect(originAsRoute({ adminId: "1553029", teamId: "T" }, new Set(["1553029"]))).toEqual({
      id: "T",
      type: "team",
    });
  });

  it("routes as before when the non-routable set is unknown", () => {
    expect(originAsRoute({ adminId: "1553029" })).toEqual({ id: "1553029", type: "admin" });
  });
});


describe("resolveOriginRoute: back to the inbox it came from", () => {
  const BOT = new Set(["1553029"]);

  it("uses the remembered team without re-reading the conversation", async () => {
    let reads = 0;
    const route = await resolveOriginRoute({
      conversationId: "c1",
      recordedOrigin: { teamId: "5550689" },
      nonRoutableAdminIds: BOT,
      getConversation: async () => {
        reads += 1;
        return {};
      },
    });
    expect(route).toEqual({ id: "5550689", type: "team" });
    expect(reads).toBe(0);
  });

  it("re-reads and uses the current team when the poll captured it too early", async () => {
    // The real shape: caught while still parked on the Operator bot.
    const recorded: Record<string, string> = {};
    const route = await resolveOriginRoute({
      conversationId: "c2",
      recordedOrigin: { adminId: "1553029" },
      nonRoutableAdminIds: BOT,
      getConversation: async () => ({ team_assignee_id: 5550689 }),
      store: { recordTeamIfAbsent: (id, teamId) => void (recorded[id] = teamId) },
    });
    expect(route).toEqual({ id: "5550689", type: "team" });
    expect(recorded).toEqual({ c2: "5550689" });
  });

  it("never hands a conversation back to a bot admin", async () => {
    const route = await resolveOriginRoute({
      conversationId: "c3",
      recordedOrigin: { adminId: "1553029" },
      nonRoutableAdminIds: BOT,
      getConversation: async () => ({ team_assignee_id: null }),
    });
    expect(route).toBeUndefined();
  });

  it("falls back to a human admin when there is genuinely no team", async () => {
    const route = await resolveOriginRoute({
      conversationId: "c4",
      recordedOrigin: { adminId: "7864142" },
      nonRoutableAdminIds: BOT,
      getConversation: async () => ({}),
    });
    expect(route).toEqual({ id: "7864142", type: "admin" });
  });

  it("survives a failed re-read", async () => {
    const seen: string[] = [];
    const route = await resolveOriginRoute({
      conversationId: "c5",
      recordedOrigin: { adminId: "7864142" },
      nonRoutableAdminIds: BOT,
      getConversation: async () => {
        throw new Error("intercom down");
      },
      logError: (m) => void seen.push(m),
    });
    expect(route).toEqual({ id: "7864142", type: "admin" });
    expect(seen.join(" ")).toContain("c5");
  });
});

describe("OriginStore.recordTeamIfAbsent", () => {
  it("backfills a team but never overwrites one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "origin-team-"));
    const store = new OriginStore(path.join(dir, "o.json"));
    store.recordIfAbsent("c1", { adminId: "A" });
    store.recordTeamIfAbsent("c1", "T1");
    expect(store.get("c1")).toEqual({ adminId: "A", teamId: "T1" });
    store.recordTeamIfAbsent("c1", "T2");
    expect(store.get("c1")?.teamId).toBe("T1");
  });
});
