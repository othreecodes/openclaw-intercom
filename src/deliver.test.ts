import { describe, expect, it, vi } from "vitest";

import { deliverAgentReply } from "./deliver.js";
import type { ResolvedIntercomAccount } from "./types.js";

const account = (over: Partial<ResolvedIntercomAccount> = {}): ResolvedIntercomAccount =>
  ({
    accountId: "default",
    enabled: true,
    configured: true,
    token: "t",
    inbound: "poll",
    pollIntervalSeconds: 20,
    apiVersion: "2.16",
    pickupUnassigned: true,
    autoClose: true,
    createMissingTags: false,
    contactContext: true,
    persona: "",
    maxConcurrentConversations: 10,
    rateLimitPerMinute: 500,
    replyToExistingOnStart: false,
    escalationAssigneeId: "999",
    escalationAssigneeType: "team",
    escalationTargets: { fraud: { name: "fraud", id: "8407270", type: "team" } },
    allowedChannels: undefined,
    ...over,
  }) as ResolvedIntercomAccount;

function makeClient() {
  return {
    reply: vi.fn(async (_c: string, _a: string, body: string) => ({
      id: "c1",
      conversation_parts: { conversation_parts: [{ id: "p1", author: { type: "admin" } }] },
    })),
    note: vi.fn(async () => ({})),
    assignTo: vi.fn(async () => ({})),
    close: vi.fn(async () => ({})),
    listTags: vi.fn(async () => [{ id: "1", name: "Fraud report/hacked account/hacked email" }]),
    createTag: vi.fn(async (name: string) => ({ id: "9", name })),
    tagConversation: vi.fn(async () => {}),
  } as never;
}

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe("deliverAgentReply", () => {
  it("strips directives and applies note, tag and escalation on the exact leaked-reply text", async () => {
    const client = makeClient();
    const log = logger();
    const raw = [
      "I am flagging this to our security team right now so they can restrict access and protect your funds from our end.",
      "",
      "Never share your PIN, password, or any OTP with anyone. Our team is stepping in right now to secure your account.",
      "",
      "[[note: Customer reports account is being hacked right now. Escalating urgently to freeze account and investigate unauthorized access.]]",
      "[[escalate to fraud: Customer reports active account hack / unauthorized access]]",
      "[[tag: Fraud report/hacked account/hacked email]]",
    ].join("\n");

    await deliverAgentReply({
      client,
      conversationId: "c1",
      adminId: "5111943",
      account: account(),
      raw,
      logger: log,
    });

    const posted = (client as any).reply.mock.calls[0][2] as string;
    expect(posted).not.toContain("[[");
    expect(posted).not.toContain("]]");
    expect(posted).toContain("flagging this to our security team");

    expect((client as any).note).toHaveBeenCalledWith(
      "c1",
      "5111943",
      expect.stringContaining("Escalation:"),
    );
    expect((client as any).assignTo).toHaveBeenCalledWith("c1", "5111943", "8407270", "team");
    expect((client as any).tagConversation).toHaveBeenCalled();
  });

  it("still strips directive syntax even if parseDirectives somehow leaves it in (defense in depth)", async () => {
    const client = makeClient();
    const log = logger();
    // Simulate a hypothetical future parser miss by directly checking the net
    // catches literal directive-shaped text that survives to `text`.
    await deliverAgentReply({
      client,
      conversationId: "c2",
      adminId: "admin",
      account: account(),
      raw: "All good here [[note: this should never reach the customer]]",
      logger: log,
    });
    const posted = (client as any).reply.mock.calls[0][2] as string;
    expect(posted).not.toContain("[[note");
  });

  it("marks its own posted part via the provided callback", async () => {
    const client = makeClient();
    const markOwnPart = vi.fn();
    await deliverAgentReply({
      client,
      conversationId: "c1",
      adminId: "a1",
      account: account(),
      raw: "Hello there",
      logger: logger(),
      markOwnPart,
    });
    expect(markOwnPart).toHaveBeenCalledWith("c1", "p1");
  });

  it("escalates to the origin team even when the model named a different queue", async () => {
    const client = makeClient();
    await deliverAgentReply({
      client,
      conversationId: "c1",
      adminId: "5111943",
      account: account(), // configures a "fraud" queue at team id 8407270
      raw: "Sorry about that!\n[[escalate to fraud: hacked account]]",
      logger: logger(),
      originTeam: { id: "5550689", type: "team" }, // Socials -- where it came from
    });
    // Not the named "fraud" queue (8407270) -- the conversation's own inbox.
    expect((client as any).assignTo).toHaveBeenCalledWith("c1", "5111943", "5550689", "team");
  });

  it("falls back to the named queue when no origin is known", async () => {
    const client = makeClient();
    await deliverAgentReply({
      client,
      conversationId: "c1",
      adminId: "5111943",
      account: account(),
      raw: "Sorry about that!\n[[escalate to fraud: hacked account]]",
      logger: logger(),
    });
    expect((client as any).assignTo).toHaveBeenCalledWith("c1", "5111943", "8407270", "team");
  });

  it("closes on a model [[close]] directive even without a customer message", async () => {
    const client = makeClient();
    await deliverAgentReply({
      client,
      conversationId: "c1",
      adminId: "a1",
      account: account(),
      raw: "All sorted!\n[[close]]",
      logger: logger(),
    });
    expect((client as any).close).toHaveBeenCalledWith("c1", "a1");
  });

  it("does not close on a resolution phrase when the customer message is not provided", async () => {
    const client = makeClient();
    await deliverAgentReply({
      client,
      conversationId: "c1",
      adminId: "a1",
      account: account(),
      raw: "You're welcome!",
      logger: logger(),
    });
    expect((client as any).close).not.toHaveBeenCalled();
  });

  it("does close on a resolution phrase when the customer message is provided", async () => {
    const client = makeClient();
    await deliverAgentReply({
      client,
      conversationId: "c1",
      adminId: "a1",
      account: account(),
      raw: "Anytime!",
      logger: logger(),
      customerMessageBody: "thanks, that's all I needed",
    });
    expect((client as any).close).toHaveBeenCalled();
  });
});
