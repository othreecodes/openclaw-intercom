import { describe, expect, it, vi } from "vitest";

import { IntercomInbox } from "./inbox.js";
import type { IntercomConversation } from "./types.js";

/**
 * Regression: a conversation handled by a human for the afternoon re-entered
 * Sisi's scope when the customer said "that's all, thanks" — and she answered
 * five-hour-old, already-resolved messages, because her dedupe store only
 * knows what SHE has seen. Messages at or before the last human teammate
 * reply must be absorbed, not answered.
 */
describe("messages already answered by a teammate", () => {
  const build = () => {
    const onMessage = vi.fn(async (_m: { body: string; partId: string }) => {});
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
      "5111943", // Sisi's own admin id
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

  const conv = (parts: IntercomConversation["conversation_parts"]): IntercomConversation => ({
    id: "c1",
    source: { id: "s1", body: "<p>Hello</p>", author: { type: "user", id: "u1" } },
    conversation_parts: parts,
  });

  it("absorbs everything a human already handled, answers only what came after", async () => {
    const { inbox, onMessage } = build();
    await inbox.ingestConversation(
      conv({
        conversation_parts: [
          { id: "p1", body: "<p>My bank couldn't be linked</p>", author: { type: "user", id: "u1" }, created_at: 100 },
          { id: "p2", body: "<p>Liveness failed</p>", author: { type: "user", id: "u1" }, created_at: 110 },
          // A human teammate (different admin id) replied.
          { id: "p3", body: "<p>Sorted for you!</p>", author: { type: "admin", id: "10258130" }, created_at: 200 },
          // Only this is genuinely unanswered.
          { id: "p4", body: "<p>That's all for now, thank you</p>", author: { type: "user", id: "u1" }, created_at: 300 },
        ],
      }),
    );
    expect(onMessage).toHaveBeenCalledTimes(1);
    const msg = onMessage.mock.calls[0][0];
    expect(msg.body).toBe("That's all for now, thank you");
    expect(msg.body).not.toContain("bank couldn't be linked");
  });

  it("a workflow bot's auto-reply does not count as a teammate", async () => {
    const { inbox, onMessage } = build();
    await inbox.ingestConversation(
      conv({
        conversation_parts: [
          { id: "p1", body: "<p>How do I withdraw?</p>", author: { type: "user", id: "u1" }, created_at: 100 },
          // "Cowrywise typically replies in under 3m." — the operator bot.
          { id: "p2", body: "<p>Cowrywise typically replies in under 3m.</p>", author: { type: "bot", id: "1553029" }, created_at: 105 },
        ],
      }),
    );
    // The customer's message is still Sisi's to answer.
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].body).toContain("How do I withdraw?");
  });

  it("Sisi's own replies do not absorb newer customer messages", async () => {
    const { inbox, onMessage } = build();
    await inbox.ingestConversation(
      conv({
        conversation_parts: [
          { id: "p2", body: "<p>Thanks!</p>", author: { type: "admin", id: "5111943" }, created_at: 150 },
          { id: "p3", body: "<p>One more question</p>", author: { type: "user", id: "u1" }, created_at: 250 },
        ],
      }),
    );
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].body).toContain("One more question");
  });

  it("absorbs the opening message too once any teammate has replied", async () => {
    const { inbox, onMessage } = build();
    await inbox.ingestConversation(
      conv({
        conversation_parts: [
          { id: "p3", body: "<p>Handled it.</p>", author: { type: "admin", id: "10258130" }, created_at: 200 },
        ],
      }),
    );
    expect(onMessage).not.toHaveBeenCalled();
  });
});
