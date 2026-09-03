import { describe, expect, it, vi } from "vitest";

import { EscalatedStore } from "./escalated.js";
import { IntercomInbox } from "./inbox.js";
import type { IntercomConversation } from "./types.js";

/**
 * Regression test for the exact bug reported live: escalating a conversation
 * to a team clears `admin_assignee_id` but not `team_assignee_id`, and
 * Intercom's "unassigned" search only checks the former -- so the escalated
 * conversation kept coming back on every poll and Sisi kept answering it.
 */
describe("IntercomInbox stops touching an escalated conversation", () => {
  const conv = (): IntercomConversation => ({
    id: "c1",
    // Exactly the shape a team-only escalation leaves behind: no admin,
    // but a team -- which is what let it slip back into "unassigned" search
    // results before this fix.
    admin_assignee_id: 0,
    team_assignee_id: 8407270,
    source: {
      id: "s1",
      body: "<p>any message would trigger this before the fix</p>",
      author: { type: "user", id: "u1", name: "Ada" },
    },
  });

  const build = () => {
    const onMessage = vi.fn(async () => {});
    const dedupe = {
      isFresh: false,
      isProcessed: () => false,
      markProcessed: () => true,
      markOwnPart: () => {},
      isOwnPart: () => false,
    };
    const escalated = new EscalatedStore(
      `/tmp/escalated-inbox-test-${Math.random().toString(36).slice(2)}.json`,
    );
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const inbox = new IntercomInbox(
      {} as never,
      "admin-1",
      dedupe as never,
      onMessage,
      logger,
      true,
      10,
      true,
      false,
      undefined,
      escalated,
    );
    return { inbox, onMessage, escalated };
  };

  it("answers normally before escalation", async () => {
    const { inbox, onMessage } = build();
    await inbox.ingestConversation(conv());
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("never dispatches again once marked escalated, even with a new message", async () => {
    const { inbox, onMessage, escalated } = build();
    escalated.markEscalated("c1");
    await inbox.ingestConversation(conv());
    expect(onMessage).not.toHaveBeenCalled();
  });
});

/**
 * Regression for the second live failure mode: a conversation with a backlog
 * of unanswered customer messages (a human-handled thread entering Sisi's
 * scope, or a burst) used to dispatch one agent turn per message -- thirteen
 * stale messages produced thirteen replies ten seconds apart, most of them
 * re-escalating. All pending messages now become a single coalesced turn.
 */
describe("IntercomInbox coalesces a backlog into one turn", () => {
  const build = () => {
    const onMessage = vi.fn(async (_message: { body: string; partId: string }) => {});
    const dedupe = {
      isFresh: false,
      isProcessed: () => false,
      markProcessed: () => true,
      markOwnPart: () => {},
      isOwnPart: () => false,
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const inbox = new IntercomInbox(
      {} as never,
      "admin-1",
      dedupe as never,
      onMessage,
      logger,
      true,
      10,
      true,
      false,
    );
    return { inbox, onMessage };
  };

  it("dispatches one turn containing every pending message, threaded on the newest", async () => {
    const { inbox, onMessage } = build();
    await inbox.ingestConversation({
      id: "c1",
      source: {
        id: "s1",
        body: "<p>My investment was 360k</p>",
        author: { type: "user", id: "u1", name: "Gabriella" },
      },
      conversation_parts: {
        conversation_parts: [
          { id: "p2", body: "<p>I sold my stock</p>", author: { type: "user", id: "u1" } },
          { id: "p3", body: "<p>Where is my money??</p>", author: { type: "user", id: "u1" } },
        ],
      },
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
    const msg = onMessage.mock.calls[0][0];
    expect(msg.body).toContain("My investment was 360k");
    expect(msg.body).toContain("I sold my stock");
    expect(msg.body).toContain("Where is my money??");
    expect(msg.partId).toBe("p3");
  });

  it("a single new message dispatches exactly as before", async () => {
    const { inbox, onMessage } = build();
    await inbox.ingestConversation({
      id: "c1",
      source: {
        id: "s1",
        body: "<p>Hello!</p>",
        author: { type: "user", id: "u1", name: "Ada" },
      },
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].body).toBe("Hello!");
  });
});
