import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IntercomAttachment } from "./types.js";
import type { IntercomInboxLogger } from "./inbox.js";

/** Ignore anything larger: a 20MB "screenshot" is not a screenshot. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Describe at most this many images per message; mention the rest by name. */
const MAX_IMAGES_DESCRIBED = 3;

/**
 * Turn a customer's attachments into text the agent can actually use.
 *
 * Instagram customers routinely answer "can you share a screenshot?" with an
 * image-only message. Intercom delivers those with an empty body and the file
 * under `attachments` — which this plugin used to drop entirely, so the bot
 * denied ever receiving the screenshot and escalated. Images are downloaded
 * from Intercom's CDN (the URLs are pre-signed, no auth needed) and run
 * through the runtime's media understanding, and the description is appended
 * to the message text. Non-image files are named so the agent at least knows
 * they exist.
 *
 * `download` and `describe` are injected so this is testable without a live
 * CDN or model; the real wiring lives in index.ts.
 */
export async function describeAttachments(params: {
  attachments: IntercomAttachment[];
  logger: IntercomInboxLogger;
  download: (url: string, filePath: string) => Promise<number>;
  describe: (filePath: string) => Promise<string>;
}): Promise<string> {
  const { attachments, logger } = params;
  const lines: string[] = [];
  let described = 0;

  for (const att of attachments) {
    const name = att.name || "file";
    const isImage = (att.content_type ?? "").startsWith("image/");
    if (!isImage || !att.url) {
      lines.push(`[The customer attached a file: ${name} (${att.content_type ?? "unknown type"})]`);
      continue;
    }
    if ((att.filesize ?? 0) > MAX_IMAGE_BYTES) {
      lines.push(`[The customer attached an image too large to view: ${name}]`);
      continue;
    }
    if (described >= MAX_IMAGES_DESCRIBED) {
      lines.push(`[The customer attached another image: ${name}]`);
      continue;
    }
    // Inline Instagram images have no filename; .jpg lets the describer sniff MIME.
    const ext = path.extname(name) || ".jpg";
    const tmp = path.join(os.tmpdir(), `intercom-att-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    try {
      await params.download(att.url, tmp);
      const description = (await params.describe(tmp)).trim();
      described += 1;
      lines.push(
        description
          ? `[The customer sent an image (${name}). What it shows: ${description}]`
          : `[The customer sent an image (${name}) that could not be described]`,
      );
    } catch (err) {
      logger.warn(`intercom: failed to view attachment ${name}: ${String(err)}`);
      // The agent must still know the image exists — "I never got an image"
      // when the customer just sent one is exactly the failure this fixes.
      lines.push(
        `[The customer sent an image (${name}) but it could not be viewed right now. ` +
          `Ask them to type out the key details instead of denying it arrived.]`,
      );
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return lines.join("\n");
}

/** Plain-fetch download for the real wiring. Exported for reuse, not tested live. */
export async function downloadToFile(url: string, filePath: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`attachment too large: ${buf.length} bytes`);
  fs.writeFileSync(filePath, buf);
  return buf.length;
}
