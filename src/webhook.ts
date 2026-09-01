
import crypto from "node:crypto";
import { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { IntercomWebhookPayload } from "./types.js";

export function verifyIntercomSignature(body: string, secret: string, signature: string): boolean {
  if (!signature.startsWith("sha1=")) return false;
  const expected = signature.slice(5);
  const actual = crypto.createHmac("sha1", secret).update(body).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  } catch (e) {
    return false;
  }
}

export function handleIntercomWebhook(
  api: OpenClawPluginApi,
  secret: string,
  onNewPart: (conversationId: string, body: string, authorId: string, partId: string) => Promise<void>
) {
  return async (req: any, res: any) => {
    const signature = req.headers["x-hub-signature"] as string;
    
    // In OpenClaw, req.rawBody is typically available for signature verification
    const body = req.rawBody || JSON.stringify(req.body);

    if (!signature || !verifyIntercomSignature(body, secret, signature)) {
      api.logger.warn("Intercom webhook: invalid signature");
      res.status(401).send("Invalid signature");
      return;
    }

    const payload = req.body as IntercomWebhookPayload;
    const item = payload.data.item;
    const conversationId = item.id;

    api.logger.info(`Intercom webhook received: ${payload.topic} for conversation ${conversationId}`);

    if (payload.topic === "conversation.user.created") {
       await onNewPart(conversationId, item.source.body, item.source.author.id, `source-${conversationId}`);
    } else if (payload.topic === "conversation.user.replied") {
       // Find the most recent user part
       const parts = item.conversation_parts.conversation_parts;
       const lastUserPart = [...parts].reverse().find(p => p.author.type === "user");
       if (lastUserPart && lastUserPart.body) {
         await onNewPart(conversationId, lastUserPart.body, lastUserPart.author.id, lastUserPart.id);
       }
    }

    res.status(200).send("OK");
  };
}
