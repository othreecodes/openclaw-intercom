import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findLatestAdminPartId, intercomChannel, stripIntercomTargetPrefix } from "./channel.js";
import { IntercomClient } from "./client.js";
import { resolveIntercomAccount } from "./config.js";
import { IntercomDedupeStore } from "./dedupe.js";
import { IntercomInbox, intercomBodyToText, type InboundIntercomMessage } from "./inbox.js";
import type { IntercomConversation } from "./types.js";
import { createIntercomWebhookHandler, verifyIntercomSignature } from "./webhook.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function tempStateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intercom-test-"));
  return path.join(dir, "dedupe.json");
}

function conversation(overrides: Partial<IntercomConversation> = {}): IntercomConversation {
  return {
    id: "conv-1",
    source: {
      id: "src-1",
      body: "<p>Hello there</p>",
      author: { type: "user", id: "user-1", name: "Ada" },
    },
    conversation_parts: {
      conversation_parts: [
        {
          id: "part-1",
          part_type: "comment",
          body: "<p>Follow-up</p>",
          created_at: 1700000000,
          author: { type: "user", id: "user-1" },
        },
        {
          id: "part-2",
          part_type: "comment",
          body: "<p>Our reply</p>",
          author: { type: "admin", id: "admin-9" },
        },
      ],
    },
    ...overrides,
  };
}

describe("config resolution", () => {
  it("resolves defaults from a minimal channel section", () => {
    const cfg = { channels: { intercom: { token: "tok" } } } as any;
    const account = resolveIntercomAccount(cfg, null);
    expect(account.configured).toBe(true);
    expect(account.token).toBe("tok");
    expect(account.inbound).toBe("poll");
    expect(account.pollIntervalSeconds).toBe(20);
    expect(account.apiVersion).toBe("2.16");
  });

  it("reports unconfigured without a token", () => {
    const account = resolveIntercomAccount({ channels: {} } as any, null);
    expect(account.configured).toBe(false);
  });

  it("honors explicit inbound mode and poll interval", () => {
    const cfg = {
      channels: {
        intercom: { token: "tok", inbound: "both", pollIntervalSeconds: 5, apiVersion: "2.15" },
      },
    } as any;
    const account = resolveIntercomAccount(cfg, null);
    expect(account.inbound).toBe("both");
    expect(account.pollIntervalSeconds).toBe(5);
    expect(account.apiVersion).toBe("2.15");
  });

  it("exposes the same resolution through the channel plugin config adapter", () => {
    const cfg = { channels: { intercom: { token: "tok" } } } as any;
    const account = intercomChannel.config.resolveAccount(cfg, undefined);
    expect(account.configured).toBe(true);
    const inspected = intercomChannel.config.inspectAccount!(cfg, undefined) as any;
    expect(inspected.configured).toBe(true);
    expect(inspected.tokenStatus).toBe("available");
  });
});

describe("IntercomClient request shaping", () => {
  const mockFetch = vi.fn();
  let client: IntercomClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new IntercomClient("test-token", "2.16", mockFetch as unknown as typeof fetch);
  });

  function okResponse(json: unknown) {
    return {
      ok: true,
      status: 200,
      json: async () => json,
      text: async () => JSON.stringify(json),
      headers: new Headers(),
    };
  }

  it("shapes GET /me with auth and version headers", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ id: "admin-1" }));
    const me = await client.me();
    expect(me.id).toBe("admin-1");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.intercom.io/me");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer test-token");
    expect(init.headers["Intercom-Version"]).toBe("2.16");
    expect(init.headers.Accept).toBe("application/json");
    expect(init.body).toBeUndefined();
  });

  it("shapes the assigned-open conversation search", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ conversations: [{ id: "c1" }] }));
    const results = await client.searchAssignedConversations("admin-1");
    expect(results).toEqual([{ id: "c1" }]);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.intercom.io/conversations/search");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.query).toEqual({
      operator: "AND",
      value: [
        { field: "admin_assignee_id", operator: "=", value: "admin-1" },
        { field: "open", operator: "=", value: true },
      ],
    });
    expect(body.sort_by).toBe("updated_at");
    expect(body.sort_order).toBe("desc");
  });

  it("shapes the admin comment reply", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ id: "c1" }));
    await client.reply("c1", "admin-1", "hi!");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.intercom.io/conversations/c1/reply");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      message_type: "comment",
      type: "admin",
      admin_id: "admin-1",
      body: "hi!",
    });
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("throws a clear error on non-2xx", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => '{"errors":[{"message":"bad token"}]}',
      headers: new Headers(),
    });
    await expect(client.me()).rejects.toThrow(/401.*bad token/s);
  });

  it("retries once on 429 honoring Retry-After", async () => {
    vi.useFakeTimers();
    try {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: async () => "rate limited",
          headers: new Headers({ "Retry-After": "2" }),
        })
        .mockResolvedValueOnce(okResponse({ id: "admin-1" }));
      const pending = client.me();
      await vi.advanceTimersByTimeAsync(2000);
      const me = await pending;
      expect(me.id).toBe("admin-1");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("webhook signature verification", () => {
  const secret = "shh";
  const body = '{"topic":"conversation.user.replied"}';
  const sign = (raw: string, key: string) =>
    `sha1=${crypto.createHmac("sha1", key).update(raw).digest("hex")}`;

  it("accepts a valid signature", () => {
    expect(verifyIntercomSignature(body, secret, sign(body, secret))).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(verifyIntercomSignature(body, secret, sign(body, "other"))).toBe(false);
  });

  it("rejects tampered bodies, malformed prefixes, and bad hex", () => {
    expect(verifyIntercomSignature("tampered", secret, sign(body, secret))).toBe(false);
    expect(verifyIntercomSignature(body, secret, "sha256=abcdef")).toBe(false);
    expect(verifyIntercomSignature(body, secret, "sha1=nothex")).toBe(false);
    expect(verifyIntercomSignature(body, secret, "sha1=")).toBe(false);
  });
});

function makeRequest(body: string, headers: Record<string, string>, method = "POST") {
  const req = new EventEmitter() as any;
  req.method = method;
  req.headers = headers;
  req.destroy = () => {};
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function makeResponse() {
  const res: any = { statusCode: 0, ended: undefined as string | undefined };
  res.end = (text?: string) => {
    res.ended = text ?? "";
  };
  return res;
}

describe("webhook handler", () => {
  const secret = "whsec";
  const sign = (raw: string) => `sha1=${crypto.createHmac("sha1", secret).update(raw).digest("hex")}`;

  function makeInbox(onMessage: (m: InboundIntercomMessage) => Promise<void>) {
    const dedupe = new IntercomDedupeStore(tempStateFile());
    const client = {} as IntercomClient;
    return new IntercomInbox(client, "admin-1", dedupe, onMessage, silentLogger);
  }

  it("dispatches new customer parts for a valid signed payload", async () => {
    const seen: InboundIntercomMessage[] = [];
    const inbox = makeInbox(async (m) => {
      seen.push(m);
    });
    const handler = createIntercomWebhookHandler({ secret, inbox, logger: silentLogger });
    const body = JSON.stringify({
      topic: "conversation.user.replied",
      data: { item: conversation() },
    });
    const res = makeResponse();
    await handler(makeRequest(body, { "x-hub-signature": sign(body) }), res);
    await new Promise((resolve) => setImmediate(resolve));
    expect(res.statusCode).toBe(200);
    expect(seen.map((m) => m.partId)).toEqual(["source-src-1", "part-1"]);
    expect(seen[0].body).toBe("Hello there");
  });

  it("rejects an invalid signature with 401 and dispatches nothing", async () => {
    const onMessage = vi.fn();
    const inbox = makeInbox(onMessage);
    const handler = createIntercomWebhookHandler({ secret, inbox, logger: silentLogger });
    const body = JSON.stringify({ topic: "conversation.user.replied", data: { item: conversation() } });
    const res = makeResponse();
    await handler(makeRequest(body, { "x-hub-signature": "sha1=deadbeef" }), res);
    expect(res.statusCode).toBe(401);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("acks unhandled topics without dispatching", async () => {
    const onMessage = vi.fn();
    const inbox = makeInbox(onMessage);
    const handler = createIntercomWebhookHandler({ secret, inbox, logger: silentLogger });
    const body = JSON.stringify({ topic: "conversation.admin.replied", data: { item: conversation() } });
    const res = makeResponse();
    await handler(makeRequest(body, { "x-hub-signature": sign(body) }), res);
    await new Promise((resolve) => setImmediate(resolve));
    expect(res.statusCode).toBe(200);
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("dedupe and both-mode single dispatch", () => {
  it("never dispatches the same part id twice through one inbox", async () => {
    const seen: string[] = [];
    const dedupe = new IntercomDedupeStore(tempStateFile());
    const inbox = new IntercomInbox({} as IntercomClient, "admin-1", dedupe, async (m) => {
      seen.push(m.partId);
    }, silentLogger);

    // Simulate poll ingesting the conversation, then webhook delivering it again.
    await inbox.ingestConversation(conversation());
    await inbox.ingestConversation(conversation());
    expect(seen).toEqual(["source-src-1", "part-1"]);
  });

  it("skips admin/bot parts and never dispatches our own replies", async () => {
    const seen: string[] = [];
    const dedupe = new IntercomDedupeStore(tempStateFile());
    const inbox = new IntercomInbox({} as IntercomClient, "admin-1", dedupe, async (m) => {
      seen.push(m.partId);
    }, silentLogger);
    inbox.markOwnPart("conv-1", "part-1");
    await inbox.ingestConversation(conversation());
    expect(seen).toEqual(["source-src-1"]);
  });

  it("persists dedupe state across restarts", async () => {
    const stateFile = tempStateFile();
    const first = new IntercomDedupeStore(stateFile);
    first.markProcessed("conv-1", "part-1");

    const seen: string[] = [];
    const reloaded = new IntercomDedupeStore(stateFile);
    const inbox = new IntercomInbox({} as IntercomClient, "admin-1", reloaded, async (m) => {
      seen.push(m.partId);
    }, silentLogger);
    await inbox.ingestConversation(conversation());
    expect(seen).toEqual(["source-src-1"]);
  });
});

describe("poll loop", () => {
  it("searches assigned conversations and ingests full detail", async () => {
    const seen: string[] = [];
    const dedupe = new IntercomDedupeStore(tempStateFile());
    const client = {
      searchAssignedConversations: vi.fn(async () => [{ id: "conv-1" }]),
      getConversation: vi.fn(async () => conversation()),
    } as unknown as IntercomClient;
    const inbox = new IntercomInbox(client, "admin-1", dedupe, async (m) => {
      seen.push(m.partId);
    }, silentLogger);
    await inbox.pollOnce();
    expect((client.searchAssignedConversations as any).mock.calls[0][0]).toBe("admin-1");
    expect((client.getConversation as any).mock.calls[0][0]).toBe("conv-1");
    expect(seen).toEqual(["source-src-1", "part-1"]);
  });
});

describe("helpers", () => {
  it("strips intercom: target prefixes", () => {
    expect(stripIntercomTargetPrefix("intercom:123")).toBe("123");
    expect(stripIntercomTargetPrefix(" 123 ")).toBe("123");
  });

  it("finds the latest admin part id in a reply response", () => {
    expect(findLatestAdminPartId(conversation())).toBe("part-2");
    expect(findLatestAdminPartId({ id: "x" })).toBeUndefined();
  });

  it("converts html bodies to text", () => {
    expect(intercomBodyToText("<p>Hi &amp; bye</p><p>line 2</p>")).toBe("Hi & bye\n\nline 2");
  });
});
