import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IntercomClient } from "./client.js";
import type { IntercomInbox, IntercomInboxLogger } from "./inbox.js";
import type { IntercomWebhookPayload } from "./types.js";

const HANDLED_TOPICS = new Set(["conversation.user.created", "conversation.user.replied"]);
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function verifyIntercomSignature(rawBody: string | Buffer, secret: string, signature: string): boolean {
  if (!signature.startsWith("sha1=")) return false;
  const expected = Buffer.from(signature.slice(5), "hex");
  const actual = crypto.createHmac("sha1", secret).update(rawBody).digest();
  if (expected.length !== actual.length || expected.length === 0) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("intercom webhook body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function respond(res: ServerResponse, status: number, text: string): void {
  res.statusCode = status;
  res.end(text);
}

/**
 * Node HTTP handler for `POST /intercom/webhook`. Verifies the Intercom
 * `X-Hub-Signature` (HMAC-SHA1 of the raw body) and funnels handled topics
 * into the shared inbox ingest path.
 */
export function createIntercomWebhookHandler(params: {
  secret: string;
  inbox: IntercomInbox;
  logger: IntercomInboxLogger;
  /** When set, the canonical conversation is fetched before ingesting. */
  client?: Pick<IntercomClient, "getConversation">;
}) {
  const { secret, inbox, logger, client } = params;
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if ((req.method ?? "").toUpperCase() !== "POST") {
      respond(res, 405, "method not allowed");
      return true;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readRawBody(req);
    } catch (err) {
      logger.warn(`intercom webhook: failed to read body: ${String(err)}`);
      respond(res, 400, "bad request");
      return true;
    }

    const signature = req.headers["x-hub-signature"];
    if (typeof signature !== "string" || !verifyIntercomSignature(rawBody, secret, signature)) {
      logger.warn("intercom webhook: invalid or missing X-Hub-Signature");
      respond(res, 401, "invalid signature");
      return true;
    }

    let payload: IntercomWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as IntercomWebhookPayload;
    } catch {
      respond(res, 400, "invalid json");
      return true;
    }

    const topic = payload.topic ?? "";
    const item = payload.data?.item;
    if (HANDLED_TOPICS.has(topic) && item?.id) {
      // Ack fast; ingest shares the poll path's dedupe so "both" mode never double-answers.
      // Use the same per-conversation gate the poll loop uses, so a webhook
      // delivery and a concurrent poll never drive one conversation at once.
      //
      // The payload is treated as a NOTIFICATION, not as data: Intercom renders
      // webhook part bodies differently from the API -- an Instagram photo
      // arrives in the payload with its <img> flattened away -- and because the
      // webhook usually beats the poll, its degraded copy used to win the
      // dedupe race and the canonical body was never seen. Fetch the real
      // conversation first; fall back to the payload only if the fetch fails.
      void inbox
        .withConversationLock(item.id, async () => {
          let conversation = item;
          if (client) {
            try {
              conversation = await client.getConversation(item.id);
            } catch (err) {
              logger.warn(
                `intercom webhook: falling back to payload body for ${item.id}; fetch failed: ${String(err)}`,
              );
            }
          }
          return inbox.ingestConversation(conversation);
        })
        .catch((err) => {
          logger.error(`intercom webhook: ingest failed for conversation ${item.id}: ${String(err)}`);
        });
    }

    respond(res, 200, "ok");
    return true;
  };
}
