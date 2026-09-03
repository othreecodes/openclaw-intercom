import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { describeAttachments } from "./media.js";
import { extractInlineImages, IntercomInbox } from "./inbox.js";

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe("describeAttachments", () => {
  it("downloads and describes an image, cleaning up the temp file", async () => {
    let savedPath = "";
    const out = await describeAttachments({
      attachments: [{ name: "receipt.png", content_type: "image/png", url: "https://cdn/x" }],
      logger: logger(),
      download: async (_url, filePath) => {
        savedPath = filePath;
        fs.writeFileSync(filePath, "fake");
        return 4;
      },
      describe: async () => "A bank transfer receipt of NGN 10,000 dated Sep 3",
    });
    expect(out).toContain("receipt.png");
    expect(out).toContain("bank transfer receipt of NGN 10,000");
    expect(fs.existsSync(savedPath)).toBe(false);
  });

  it("tells the agent an image arrived even when viewing fails", async () => {
    const out = await describeAttachments({
      attachments: [{ name: "shot.jpg", content_type: "image/jpeg", url: "https://cdn/x" }],
      logger: logger(),
      download: async () => {
        throw new Error("CDN down");
      },
      describe: async () => "unused",
    });
    expect(out).toContain("could not be viewed");
    expect(out).toContain("denying it arrived");
  });

  it("names non-image files without trying to describe them", async () => {
    const describeFn = vi.fn();
    const out = await describeAttachments({
      attachments: [{ name: "statement.pdf", content_type: "application/pdf", url: "https://cdn/x" }],
      logger: logger(),
      download: async () => 0,
      describe: describeFn,
    });
    expect(out).toContain("statement.pdf");
    expect(describeFn).not.toHaveBeenCalled();
  });

  it("caps described images and names the overflow", async () => {
    const atts = [1, 2, 3, 4, 5].map((i) => ({
      name: `img${i}.png`,
      content_type: "image/png",
      url: `https://cdn/${i}`,
    }));
    const out = await describeAttachments({
      attachments: atts,
      logger: logger(),
      download: async (_u, f) => (fs.writeFileSync(f, "x"), 1),
      describe: async () => "desc",
    });
    expect(out.match(/What it shows/g)?.length).toBe(3);
    expect(out).toContain("another image: img4.png");
  });
});

describe("image-only messages reach the agent", () => {
  const build = () => {
    const onMessage = vi.fn(async (_m: { body: string; attachments?: unknown[] }) => {});
    const dedupe = {
      isFresh: false,
      isProcessed: () => false,
      markProcessed: () => true,
      markOwnPart: () => {},
      isOwnPart: () => false,
    };
    const inbox = new IntercomInbox(
      {} as never,
      "admin-1",
      dedupe as never,
      onMessage,
      logger(),
      true,
      10,
      true,
      false,
    );
    return { inbox, onMessage };
  };

  it("dispatches a part with an empty body but an attachment", async () => {
    const { inbox, onMessage } = build();
    await inbox.ingestConversation({
      id: "c1",
      conversation_parts: {
        conversation_parts: [
          {
            id: "p1",
            body: "",
            author: { type: "user", id: "u1" },
            attachments: [{ name: "IMG_5698.png", content_type: "image/png", url: "https://cdn/i" }],
          },
        ],
      },
    });
    // Before this fix, the empty body meant the part was skipped entirely and
    // the bot told the customer no image had arrived.
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].attachments).toHaveLength(1);
  });

  it("coalesces text and an image from separate messages into one turn", async () => {
    const { inbox, onMessage } = build();
    await inbox.ingestConversation({
      id: "c1",
      conversation_parts: {
        conversation_parts: [
          { id: "p1", body: "<p>Here is the receipt</p>", author: { type: "user", id: "u1" } },
          {
            id: "p2",
            body: "",
            author: { type: "user", id: "u1" },
            attachments: [{ name: "receipt.png", content_type: "image/png", url: "https://cdn/i" }],
          },
        ],
      },
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
    const msg = onMessage.mock.calls[0][0];
    expect(msg.body).toContain("Here is the receipt");
    expect(msg.attachments).toHaveLength(1);
  });
});

describe("extractInlineImages", () => {
  it("finds an Instagram DM image embedded in the body with empty attachments", () => {
    const body =
      '<div class="intercom-container"><img src="https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=232009&amp;signature=Ab0ZQ"></div>';
    const out = extractInlineImages(body);
    expect(out).toHaveLength(1);
    // Entity-decoded: the signed query string must keep a literal ampersand.
    expect(out[0].url).toBe("https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=232009&signature=Ab0ZQ");
    expect(out[0].content_type).toBe("image/unknown");
  });

  it("returns nothing for a plain text body", () => {
    expect(extractInlineImages("<p>How much for this?</p>")).toHaveLength(0);
    expect(extractInlineImages("")).toHaveLength(0);
    expect(extractInlineImages(null)).toHaveLength(0);
  });

  it("ignores non-http sources", () => {
    expect(extractInlineImages('<img src="data:image/png;base64,AAAA">')).toHaveLength(0);
  });
});

describe("inline images reach the agent (the Instagram shape)", () => {
  it("dispatches a body-only image part with the extracted attachment", async () => {
    const onMessage = vi.fn(async (_m: { attachments?: { url?: string }[] }) => {});
    const dedupe = {
      isFresh: false,
      isProcessed: () => false,
      markProcessed: () => true,
      markOwnPart: () => {},
      isOwnPart: () => false,
    };
    const inbox = new IntercomInbox(
      {} as never, "admin-1", dedupe as never, onMessage,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      true, 10, true, false,
    );
    await inbox.ingestConversation({
      id: "c1",
      conversation_parts: {
        conversation_parts: [
          {
            id: "p1",
            body: '<div class="intercom-container"><img src="https://lookaside.fbsbx.com/x?a=1&amp;s=2"></div>',
            author: { type: "user", id: "u1" },
            attachments: [],
          },
        ],
      },
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].attachments?.[0]?.url).toBe("https://lookaside.fbsbx.com/x?a=1&s=2");
  });
});
