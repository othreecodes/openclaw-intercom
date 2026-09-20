import { describe, expect, it } from "vitest";
import {
  CONVERSATION_INFO_SENTINEL,
  buildMemoryMetadataBlock,
  wrapInstructionsForMemory,
} from "./memory-metadata.js";

/**
 * Reimplementation of the Honcho plugin parser (helpers.js extractSenderId).
 * The block is a contract with code we do not own, so the test asserts against
 * that parser behaviour rather than against our own string.
 */
function extractSenderId(content: string): string | undefined {
  if (!content.includes(CONVERSATION_INFO_SENTINEL)) return undefined;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== CONVERSATION_INFO_SENTINEL) continue;
    if (lines[i + 1]?.trim() !== "```json") return undefined;
    const json: string[] = [];
    for (let j = i + 2; j < lines.length; j += 1) {
      if (lines[j].trim() === "```") break;
      json.push(lines[j]);
    }
    try {
      const parsed = JSON.parse(json.join("\n")) as { sender_id?: string };
      return parsed.sender_id;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Reimplementation of the plugin tag strip (helpers.js cleanMessageContent). */
function stripHonchoTags(content: string): string {
  return content.replace(/<honcho-memory[^>]*>[\s\S]*?<\/honcho-memory>\s*/gi, "").trim();
}

describe("buildMemoryMetadataBlock", () => {
  it("is readable by the plugin parser", () => {
    const block = buildMemoryMetadataBlock({
      contactId: "66d1f0a2b1",
      senderName: "Ada",
      channel: "WhatsApp",
      conversationId: "215475995223238",
    });
    expect(extractSenderId(block)).toBe("intercom-66d1f0a2b1");
  });

  it("still parses when the customer has no name -- anonymous widget leads have none", () => {
    const block = buildMemoryMetadataBlock({
      contactId: "abc",
      conversationId: "1",
    });
    expect(extractSenderId(block)).toBe("intercom-abc");
    expect(block).not.toContain("\"sender\"");
  });

  it("gives each contact its own peer id, so customers cannot merge", () => {
    const a = extractSenderId(buildMemoryMetadataBlock({ contactId: "aaa", conversationId: "1" }));
    const b = extractSenderId(buildMemoryMetadataBlock({ contactId: "bbb", conversationId: "2" }));
    expect(a).not.toBe(b);
  });

  it("survives a name with quotes and newlines", () => {
    const block = buildMemoryMetadataBlock({
      contactId: "x1",
      senderName: "A\"wkward\nName",
      conversationId: "2",
    });
    expect(extractSenderId(block)).toBe("intercom-x1");
  });
});

describe("wrapInstructionsForMemory", () => {
  it("keeps the preamble out of what Honcho stores", () => {
    const body =
      wrapInstructionsForMemory("[Intercom support chat. You are Sisi.]") +
      "\n" +
      buildMemoryMetadataBlock({ contactId: "x", conversationId: "1" }) +
      "\n\nMy withdrawal is pending.";
    const stored = stripHonchoTags(body);
    expect(stored).not.toContain("You are Sisi");
    expect(stored).toContain("My withdrawal is pending.");
  });

  it("leaves the sender id readable after wrapping", () => {
    const body =
      wrapInstructionsForMemory("[persona]") +
      "\n" +
      buildMemoryMetadataBlock({ contactId: "x", conversationId: "1" });
    expect(extractSenderId(body)).toBe("intercom-x");
  });
});
