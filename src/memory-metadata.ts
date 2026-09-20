/**
 * Glue for the Honcho memory plugin (@honcho-ai/openclaw-honcho).
 *
 * Two things go wrong without it, both found on the live box:
 *
 * 1. The plugin identifies the speaker by reading a "Conversation info
 *    (untrusted metadata):" block out of the message body. OpenClaw only emits
 *    that block for group chats, and Intercom dispatches every conversation as
 *    a direct DM -- so the plugin fell back to its shared `owner` peer and
 *    every customer we have ever answered piled into one profile.
 *
 * 2. The body we hand the agent opens with the whole persona preamble. The
 *    plugin stores the user message verbatim, so Honcho was deriving facts
 *    about the customer from Sisi own instructions.
 *
 * The shapes below are the plugin contract, not decoration: the sentinel must
 * sit alone on its line with a ```json fence directly beneath it, and the
 * <honcho-memory> tag is the marker it strips before storing.
 */

/** Sentinel the plugin matches, trimmed and on a line of its own. */
export const CONVERSATION_INFO_SENTINEL = "Conversation info (untrusted metadata):";

/**
 * Wrap text the agent should read but Honcho must not store. The plugin strips
 * `<honcho-memory ...>...</honcho-memory>` before saving; the bracketed framing
 * inside still tells the model what the text is, so the prompt reads the same.
 */
export function wrapInstructionsForMemory(text: string): string {
  return `<honcho-memory role="instructions">${text}</honcho-memory>`;
}

/**
 * Build the identity block. `senderId` becomes the Honcho peer id after the
 * plugin sanitises it to [A-Za-z0-9_-], so it is prefixed and kept ASCII here
 * rather than left as a bare numeric contact id.
 */
export function buildMemoryMetadataBlock(params: {
  contactId: string;
  senderName?: string;
  channel?: string;
  conversationId: string;
}): string {
  const payload: Record<string, string> = {
    sender_id: `intercom-${params.contactId}`,
    conversation_id: params.conversationId,
  };
  if (params.senderName) payload.sender = params.senderName;
  if (params.channel) payload.channel = params.channel;
  return [
    CONVERSATION_INFO_SENTINEL,
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
}
