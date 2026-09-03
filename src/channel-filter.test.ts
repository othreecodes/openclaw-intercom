import { describe, expect, it, vi } from "vitest";

import { normalizeAllowedChannels } from "./config.js";
import { conversationChannel, IntercomInbox } from "./inbox.js";
import type { IntercomConversation } from "./types.js";

const conv = (over: Partial<IntercomConversation> = {}): IntercomConversation => ({
  id: "c1",
  source: {
    id: "s1",
    body: "<p>hello</p>",
    author: { type: "user", id: "u1", name: "Ada" },
  },
  ...over,
});

describe("conversationChannel", () => {
  it("prefers where the conversation is now over where it started", () => {
    expect(conversationChannel(conv({ channel: { initial: "messenger", current: "email" } }))).toBe(
      "email",
    );
  });

  it("falls back to the initial channel", () => {
    expect(conversationChannel(conv({ channel: { initial: "whatsapp" } }))).toBe("whatsapp");
  });

  it("maps the legacy source.type 'conversation' to messenger", () => {
    expect(conversationChannel(conv({ source: { type: "conversation" } }))).toBe("messenger");
  });

  it("is undefined when the payload does not say", () => {
    expect(conversationChannel(conv())).toBeUndefined();
  });
});

describe("normalizeAllowedChannels", () => {
  it("lowercases, trims and de-duplicates", () => {
    expect(normalizeAllowedChannels([" Messenger ", "EMAIL", "messenger"])).toEqual([
      "messenger",
      "email",
    ]);
  });

  it("treats an empty list as 'every channel' rather than 'none'", () => {
    expect(normalizeAllowedChannels([])).toBeUndefined();
    expect(normalizeAllowedChannels(undefined)).toBeUndefined();
    expect(normalizeAllowedChannels("email")).toBeUndefined();
  });
});

describe("IntercomInbox channel gate", () => {
  const build = (allowed: string[] | undefined) => {
    const onMessage = vi.fn(async () => {});
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
      allowed,
    );
    return { inbox, onMessage, logger };
  };

  it("answers a conversation on an allowed channel", async () => {
    const { inbox, onMessage } = build(["messenger"]);
    await inbox.ingestConversation(conv({ channel: { current: "messenger" } }));
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("ignores a conversation on a channel it does not answer", async () => {
    const { inbox, onMessage, logger } = build(["messenger"]);
    await inbox.ingestConversation(conv({ channel: { current: "email" } }));
    expect(onMessage).not.toHaveBeenCalled();
    expect(logger.info.mock.calls.flat().join(" ")).toContain("email");
  });

  it("answers every channel when no allowlist is set", async () => {
    const { inbox, onMessage } = build(undefined);
    await inbox.ingestConversation(conv({ channel: { current: "whatsapp" } }));
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("answers when the channel is unknown, rather than dropping the customer", async () => {
    const { inbox, onMessage } = build(["messenger"]);
    await inbox.ingestConversation(conv());
    expect(onMessage).toHaveBeenCalledTimes(1);
  });
});
