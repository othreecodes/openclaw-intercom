import type { IntercomClient } from "./client.js";
import type { IntercomDedupeStore } from "./dedupe.js";
import type { IntercomConversation } from "./types.js";

export interface InboundIntercomMessage {
  conversationId: string;
  partId: string;
  body: string;
  authorId: string;
  authorName?: string;
  createdAt?: number;
}

export interface IntercomInboxLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/** Strip Intercom's HTML message bodies down to plain text. */
export function intercomBodyToText(body: string): string {
  return body
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/**
 * Single ingest funnel for Intercom conversations. Both the poll loop and the
 * webhook handler feed conversations through `ingestConversation`, so dedupe
 * guarantees at-most-once dispatch per conversation part even in "both" mode.
 */
export class IntercomInbox {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private tickRunning = false;

  constructor(
    private readonly client: IntercomClient,
    private readonly adminId: string,
    private readonly dedupe: IntercomDedupeStore,
    private readonly onMessage: (message: InboundIntercomMessage) => Promise<void>,
    private readonly logger: IntercomInboxLogger,
  ) {}

  /** Record a part id (e.g. our own outbound reply) so ingest never dispatches it. */
  markOwnPart(conversationId: string, partId: string): void {
    this.dedupe.markProcessed(conversationId, partId);
  }

  async ingestConversation(conversation: IntercomConversation): Promise<void> {
    const conversationId = conversation.id;
    if (!conversationId) return;

    const source = conversation.source;
    if (source?.author?.type === "user" && source.body) {
      const sourceId = source.id ? `source-${source.id}` : `source-${conversationId}`;
      if (!this.dedupe.isProcessed(conversationId, sourceId)) {
        this.dedupe.markProcessed(conversationId, sourceId);
        await this.dispatch({
          conversationId,
          partId: sourceId,
          body: intercomBodyToText(source.body),
          authorId: source.author.id,
          authorName: source.author.name ?? undefined,
        });
      }
    }

    const parts = conversation.conversation_parts?.conversation_parts ?? [];
    for (const part of parts) {
      if (part.author?.type !== "user" || !part.body || !part.id) continue;
      if (this.dedupe.isProcessed(conversationId, part.id)) continue;
      this.dedupe.markProcessed(conversationId, part.id);
      await this.dispatch({
        conversationId,
        partId: part.id,
        body: intercomBodyToText(part.body),
        authorId: part.author.id,
        authorName: part.author.name ?? undefined,
        createdAt: part.created_at,
      });
    }
  }

  private async dispatch(message: InboundIntercomMessage): Promise<void> {
    if (!message.body) return;
    try {
      await this.onMessage(message);
    } catch (err) {
      this.logger.error(
        `intercom: failed to dispatch part ${message.partId} of conversation ${message.conversationId}: ${String(err)}`,
      );
    }
  }

  async pollOnce(): Promise<void> {
    const conversations = await this.client.searchAssignedConversations(this.adminId);
    for (const conversation of conversations) {
      if (this.stopped) return;
      const full = await this.client.getConversation(conversation.id);
      await this.ingestConversation(full);
    }
  }

  startPolling(intervalSeconds: number): void {
    const intervalMs = Math.max(1, intervalSeconds) * 1000;
    const tick = async () => {
      if (this.stopped || this.tickRunning) return;
      this.tickRunning = true;
      try {
        await this.pollOnce();
      } catch (err) {
        this.logger.warn(`intercom: poll tick failed: ${String(err)}`);
      } finally {
        this.tickRunning = false;
      }
    };
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref?.();
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
