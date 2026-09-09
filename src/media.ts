import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IntercomAttachment } from "./types.js";
import type { IntercomInboxLogger } from "./inbox.js";

/** Ignore anything larger: a 20MB "screenshot" is not a screenshot. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Voice notes above this size are announced but not transcribed. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

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
  /**
   * Transcribes one voice note. Optional so existing callers and tests keep
   * working; without it audio is still announced, just not transcribed.
   */
  transcribe?: (filePath: string, mime: string) => Promise<string>;
}): Promise<string> {
  const { attachments, logger } = params;
  const lines: string[] = [];
  let described = 0;

  for (const att of attachments) {
    const name = att.name || "file";
    const type = att.content_type ?? "";
    const isImage = type.startsWith("image/");
    // WhatsApp and Instagram voice notes arrive as audio attachments with an
    // empty body. Untranscribed they were announced as "a file", so the agent
    // told customers voice notes are not supported and asked them to type.
    const isAudio = type.startsWith("audio/") || /\.(ogg|opus|m4a|mp3|wav|aac|amr)$/i.test(name);
    if (isAudio && att.url && params.transcribe) {
      if ((att.filesize ?? 0) > MAX_AUDIO_BYTES) {
        lines.push(`[The customer sent a voice note that is too long to transcribe (${name}). Ask them to summarise it in text.]`);
        continue;
      }
      const aext = path.extname(name) || ".ogg";
      const atmp = path.join(os.tmpdir(), `intercom-att-${Date.now()}-${Math.random().toString(36).slice(2)}${aext}`);
      try {
        await params.download(att.url, atmp);
        const transcript = (await params.transcribe(atmp, type || "audio/ogg")).trim();
        lines.push(
          transcript
            ? `[The customer sent a voice note. Automatic transcription, it may mishear names, ` +
              `amounts or Nigerian place names, so confirm anything critical rather than assuming: ` +
              `"${transcript}"]`
            : `[The customer sent a voice note (${name}) but nothing could be transcribed from it. ` +
              `Ask them what it said rather than saying voice notes are unsupported.]`,
        );
      } catch (err) {
        logger.warn(`intercom: failed to transcribe ${name}: ${String(err)}`);
        lines.push(
          `[The customer sent a voice note (${name}) that could not be transcribed right now. ` +
            `Ask them to type the key details. Never tell them voice notes are unsupported.]`,
        );
      } finally {
        fs.rmSync(atmp, { force: true });
      }
      continue;
    }
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
          ? `[The customer sent an image (${name}). Automated description — may be wrong, ` +
            `especially about which app or company is shown; if the customer says otherwise ` +
            `about their own screen, believe the customer: ${description}]`
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


/**
 * Which provider/model to use for describing a screenshot.
 * `describeImageFile` picks this itself but gives no token budget; the
 * with-model call needs it named explicitly, so mirror the agent's own primary
 * model and fall back to the first configured provider.
 */
export function resolveImageDescribeModel(cfg: unknown): { provider: string; model: string } {
  const c = cfg as {
    models?: {
      providers?: Record<string, { models?: Array<{ id?: string }> }>;
    };
  };
  const providers = c?.models?.providers ?? {};
  const google = providers.google;
  const googleModel = google?.models?.find((m) => typeof m?.id === "string")?.id;
  if (googleModel) return { provider: "google", model: googleModel };
  for (const [provider, entry] of Object.entries(providers)) {
    const model = entry?.models?.find((m) => typeof m?.id === "string")?.id;
    if (model) return { provider, model };
  }
  return { provider: "google", model: "gemini-3.8-flash" };
}
