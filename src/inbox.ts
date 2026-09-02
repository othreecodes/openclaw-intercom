import { AsyncLocalStorage } from "node:async_hooks";
import type { IntercomClient } from "./client.js";
import type { IntercomDedupeStore } from "./dedupe.js";
import type { IntercomContact, IntercomConversation } from "./types.js";

/**
 * Async context captured at module load, before the Gateway enters any
 * root-work admission scope.
 *
 * The poll interval and the webhook route are both created during plugin init,
 * which runs inside a Gateway root-work admission. Timers and handlers created
 * there inherit that AsyncLocalStorage store, and once the admission is
 * released every later dispatch is refused:
 *
 *   isGatewaySubordinateWorkAdmissionClosed() -> store.released === true
 *   -> GatewayDrainingError: Gateway is draining; new tasks are not accepted
 *
 * The channel then never answers anything, in any inbound mode, for the life of
 * the process. Running each dispatch in this clean snapshot detaches it from the
 * stale admission so the Gateway admits the work on its own merits.
 */
const detachedFromStartupAdmission = AsyncLocalStorage.snapshot();

export interface InboundIntercomMessage {
  conversationId: string;
  partId: string;
  body: string;
  authorId: string;
  authorName?: string;
  authorEmail?: string;
  createdAt?: number;
}

export interface IntercomInboxLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/** Messenger visitors author messages as "user" (identified) or "lead"
 * (anonymous). Both are customers we should answer; admin/bot are not. */
export function isCustomerAuthor(type: string | undefined): boolean {
  return type === "user" || type === "lead" || type === "contact";
}

/** A conversation with no admin and no team assignee is unassigned. */
export function isUnassigned(conversation: IntercomConversation): boolean {
  const admin = conversation.admin_assignee_id;
  const team = conversation.team_assignee_id;
  const empty = (v: number | string | null | undefined): boolean =>
    v === undefined || v === null || v === 0 || v === "0" || v === "";
  return empty(admin) && empty(team);
}

/** Structured actions the agent can request inline in its reply text. */
export interface AgentDirectives {
  /** The reply with all directives stripped. Empty means "act only, don't reply". */
  text: string;
  /** `[[close]]` — close the conversation. */
  close: boolean;
  /** `[[escalate]]` / `[[escalate: reason]]` — hand off to a human. */
  escalate: boolean;
  escalateReason?: string;
  /** `[[note: ...]]` — private internal notes (may repeat). */
  notes: string[];
  /** `[[tag: a, b]]` — conversation tags (may repeat / comma-list). */
  tags: string[];
}

const NOTE_DIRECTIVE = /\[\[\s*note\s*:\s*([^\]]+?)\s*\]\]/gi;
const TAG_DIRECTIVE = /\[\[\s*tags?\s*:\s*([^\]]+?)\s*\]\]/gi;
const ESCALATE_DIRECTIVE = /\[\[\s*escalate\s*(?::\s*([^\]]*?))?\s*\]\]/gi;
const CLOSE_DIRECTIVE = /\[\[\s*close\s*\]\]/gi;

/**
 * Parse the agent's reply for inline action directives, returning the cleaned
 * reply text plus the structured actions to perform. Directives are stripped so
 * they never reach the customer.
 */
export function parseDirectives(reply: string): AgentDirectives {
  const notes: string[] = [];
  const tags: string[] = [];
  let escalate = false;
  let escalateReason: string | undefined;

  let text = reply.replace(NOTE_DIRECTIVE, (_m, body: string) => {
    const b = body.trim();
    if (b) notes.push(b);
    return "";
  });
  text = text.replace(TAG_DIRECTIVE, (_m, list: string) => {
    for (const raw of list.split(",")) {
      const tag = raw.trim();
      if (tag) tags.push(tag);
    }
    return "";
  });
  text = text.replace(ESCALATE_DIRECTIVE, (_m, reason?: string) => {
    escalate = true;
    const r = reason?.trim();
    if (r) escalateReason = r;
    return "";
  });
  const beforeClose = text;
  text = text.replace(CLOSE_DIRECTIVE, "");
  const close = text !== beforeClose;

  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, close, escalate, escalateReason, notes, tags };
}

/** Back-compat helper: close-only view of {@link parseDirectives}. */
export function parseCloseDirective(reply: string): { text: string; close: boolean } {
  const d = parseDirectives(reply);
  return { text: d.text, close: d.close };
}

type TagClient = Pick<IntercomClient, "listTags" | "createTag" | "tagConversation">;

/**
 * Resolve tag names to ids (creating missing ones when allowed) and attach them
 * to a conversation. Returns the names actually applied.
 */
export async function applyConversationTags(
  client: TagClient,
  conversationId: string,
  adminId: string,
  tagNames: string[],
  createMissing: boolean,
): Promise<string[]> {
  if (tagNames.length === 0) return [];
  const existing = await client.listTags();
  const byName = new Map(existing.map((t) => [t.name.toLowerCase(), t]));
  const applied: string[] = [];
  for (const name of tagNames) {
    let tag = byName.get(name.toLowerCase());
    if (!tag) {
      if (!createMissing) continue;
      tag = await client.createTag(name);
      byName.set(name.toLowerCase(), tag);
    }
    await client.tagConversation(conversationId, tag.id, adminId);
    applied.push(tag.name);
  }
  return applied;
}

/** Compact one-line profile summary for reply context (name/email live elsewhere). */
export function summarizeContact(contact: IntercomContact): string {
  const bits: string[] = [];
  if (contact.role) bits.push(contact.role);
  if (contact.phone) bits.push(contact.phone);
  const place = [contact.location?.city, contact.location?.region, contact.location?.country]
    .filter(Boolean)
    .join(", ");
  if (place) bits.push(place);
  if (contact.custom_attributes) {
    for (const [key, value] of Object.entries(contact.custom_attributes)) {
      if (value === null || value === undefined || value === "") continue;
      bits.push(`${key}: ${String(value)}`);
      if (bits.length >= 10) break;
    }
  }
  return bits.join(" · ");
}

/** Customer-signalled resolution (trigger #2): the visitor says they're done. */
const RESOLUTION_PATTERNS: RegExp[] = [
  /\bthat'?s all\b/i,
  /\bthat'?s it\b/i,
  /\ball (good|sorted|set|resolved|clear)\b/i,
  /\b(issue|problem)\s+(is\s+)?(now\s+)?(resolved|fixed|solved)\b/i,
  /\b(solved|fixed) (it|my|the)\b/i,
  /\bworks?\s+now\b/i,
  /\bno (thanks|further|more)\b/i,
  /\bthank you,?\s*(bye|goodbye)\b/i,
];

export function isResolutionPhrase(body: string): boolean {
  const text = body.trim();
  if (!text) return false;
  return RESOLUTION_PATTERNS.some((re) => re.test(text));
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

  /** Conversations currently being worked on, so no two workers touch one. */
  private readonly inFlight = new Set<string>();
  /** Last updated_at we have fully ingested, per conversation. */
  private readonly lastIngestedUpdatedAt = new Map<string, number>();

  constructor(
    private readonly client: IntercomClient,
    private readonly adminId: string,
    private readonly dedupe: IntercomDedupeStore,
    private readonly onMessage: (message: InboundIntercomMessage) => Promise<void>,
    private readonly logger: IntercomInboxLogger,
    private readonly pickupUnassigned: boolean = true,
    private readonly maxConcurrentConversations: number = 10,
    /**
     * Answer conversations that already existed the first time this channel
     * ever ran. Off by default: on a first run the dedupe store is empty, so
     * every message in every open conversation looks new and the bot would
     * reply to the entire backlog at once.
     */
    private readonly replyToExistingOnStart: boolean = false,
    /** True when the dedupe store had no prior state: a first-ever run. */
    private readonly coldStart: boolean = false,
  ) {
    // Only a cold start has a backlog to skip. Later restarts read persisted
    // dedupe state, so anything genuinely new — including messages that
    // arrived while the gateway was down — is still answered.
    this.seedingBacklog = coldStart && !replyToExistingOnStart;
  }

  /** True until the first poll pass has absorbed the pre-existing inbox. */
  private seedingBacklog = false;

  /** Whether the next poll pass will seed rather than answer. */
  get isSeedingBacklog(): boolean {
    return this.seedingBacklog;
  }

  /**
   * Record every customer message in a conversation as already handled,
   * without dispatching any of it. Used once on a cold start so history is
   * remembered but never answered.
   */
  seedConversation(conversation: IntercomConversation): number {
    const conversationId = conversation.id;
    if (!conversationId) return 0;
    let seeded = 0;

    const source = conversation.source;
    if (isCustomerAuthor(source?.author?.type) && source?.body) {
      const sourceId = source.id ? `source-${source.id}` : `source-${conversationId}`;
      if (this.dedupe.markProcessed(conversationId, sourceId)) seeded += 1;
    }
    for (const part of conversation.conversation_parts?.conversation_parts ?? []) {
      if (!isCustomerAuthor(part.author?.type) || !part.body || !part.id) continue;
      if (this.dedupe.markProcessed(conversationId, part.id)) seeded += 1;
    }
    return seeded;
  }

  /**
   * Run `work` for a conversation unless that conversation is already being
   * handled. Poll ticks and webhook deliveries share this gate, so a
   * conversation is only ever driven by one worker at a time and its parts stay
   * in order even while other conversations run in parallel.
   *
   * Returns false when the conversation was already claimed.
   */
  async withConversationLock<T>(
    conversationId: string,
    work: () => Promise<T>,
  ): Promise<T | false> {
    if (this.inFlight.has(conversationId)) return false;
    this.inFlight.add(conversationId);
    try {
      return await work();
    } finally {
      this.inFlight.delete(conversationId);
    }
  }

  /** Conversations in flight right now. Exposed for diagnostics and tests. */
  get activeConversations(): number {
    return this.inFlight.size;
  }

  /** Record a part id (e.g. our own outbound reply) so ingest never dispatches it. */
  markOwnPart(conversationId: string, partId: string): void {
    this.dedupe.markProcessed(conversationId, partId);
  }

  async ingestConversation(conversation: IntercomConversation): Promise<number> {
    const conversationId = conversation.id;
    if (!conversationId) return 0;
    let dispatched = 0;

    const source = conversation.source;
    if (isCustomerAuthor(source?.author?.type) && source?.body) {
      const sourceId = source.id ? `source-${source.id}` : `source-${conversationId}`;
      if (!this.dedupe.isProcessed(conversationId, sourceId)) {
        this.dedupe.markProcessed(conversationId, sourceId);
        dispatched += 1;
        await this.dispatch({
          conversationId,
          partId: sourceId,
          body: intercomBodyToText(source.body),
          authorId: source.author!.id,
          authorName: source.author!.name ?? undefined,
          authorEmail: source.author!.email ?? undefined,
        });
      }
    }

    const parts = conversation.conversation_parts?.conversation_parts ?? [];
    for (const part of parts) {
      if (!isCustomerAuthor(part.author?.type) || !part.body || !part.id) continue;
      if (this.dedupe.isProcessed(conversationId, part.id)) continue;
      this.dedupe.markProcessed(conversationId, part.id);
      dispatched += 1;
      await this.dispatch({
        conversationId,
        partId: part.id,
        body: intercomBodyToText(part.body),
        authorId: part.author!.id,
        authorName: part.author!.name ?? undefined,
        authorEmail: part.author!.email ?? undefined,
        createdAt: part.created_at,
      });
    }
    return dispatched;
  }

  private async dispatch(message: InboundIntercomMessage): Promise<void> {
    if (!message.body) return;
    try {
      await detachedFromStartupAdmission(() => this.onMessage(message));
    } catch (err) {
      this.logger.error(
        `intercom: failed to dispatch part ${message.partId} of conversation ${message.conversationId}: ${String(err)}`,
      );
    }
  }

  async pollOnce(): Promise<void> {
    const assigned = await this.client.searchAssignedConversations(this.adminId);
    const unassigned = this.pickupUnassigned
      ? await this.client.searchUnassignedConversations()
      : [];

    // Merge by conversation id; remember which ones arrived unassigned so we can
    // claim them for the bot admin before replying.
    const byId = new Map<string, { conversation: IntercomConversation; unassigned: boolean }>();
    for (const c of assigned) byId.set(c.id, { conversation: c, unassigned: false });
    for (const c of unassigned) {
      if (!byId.has(c.id)) byId.set(c.id, { conversation: c, unassigned: true });
    }

    // First pass after a cold start: absorb the inbox that existed before this
    // channel was ever installed. Record it as handled, answer none of it, and
    // do not claim unassigned conversations we are not going to reply to.
    if (this.seedingBacklog) {
      let seeded = 0;
      for (const { conversation } of byId.values()) {
        seeded += this.seedConversation(await this.client.getConversation(conversation.id));
      }
      this.seedingBacklog = false;
      this.logger.info(
        `intercom: first run, absorbed ${byId.size} existing conversation(s) (${seeded} message(s)) without replying; ` +
          "set channels.intercom.replyToExistingOnStart=true to answer the backlog instead",
      );
      return;
    }

    let dispatched = 0;
    let claimed = 0;
    let skipped = 0;
    let unchanged = 0;

    // Work on several conversations at once, but finish each one — reply,
    // notes, tags, then close or escalate — before that worker starts another.
    // Everything for a single conversation stays sequential and in order.
    const queue = [...byId.values()];
    const workerCount = Math.max(1, Math.min(this.maxConcurrentConversations, queue.length));

    const runOne = async (entry: (typeof queue)[number]): Promise<void> => {
      const { conversation, unassigned: wasUnassigned } = entry;

      // Search already told us when the conversation last changed. If that has
      // not moved since we finished ingesting it, there is nothing new and the
      // detail fetch would be wasted: at a short poll interval this is the
      // single largest source of avoidable API calls.
      const updatedAt = conversation.updated_at;
      if (
        typeof updatedAt === "number" &&
        this.lastIngestedUpdatedAt.get(conversation.id) === updatedAt &&
        !(this.pickupUnassigned && wasUnassigned)
      ) {
        unchanged += 1;
        return;
      }

      const outcome = await this.withConversationLock(conversation.id, async () => {
        const full = await this.client.getConversation(conversation.id);
        // Claim unassigned conversations so the bot owns follow-up and they move
        // into the assigned inbox (also avoids re-scanning them as unassigned).
        if (this.pickupUnassigned && wasUnassigned && isUnassigned(full)) {
          try {
            await this.client.assign(full.id, this.adminId);
            claimed += 1;
          } catch (err) {
            this.logger.warn(`intercom: failed to claim conversation ${full.id}: ${String(err)}`);
          }
        }
        const count = await this.ingestConversation(full);
        // Recorded only once ingest returns, so a failed fetch or ingest is
        // retried on the next tick. Note that dispatch() swallows and logs a
        // failing agent turn, and the part is already marked in the dedupe
        // store before dispatch to prevent double replies, so an agent-side
        // failure is not retried here either. That is pre-existing behaviour.
        const seenAt = full.updated_at ?? updatedAt;
        if (typeof seenAt === "number") this.lastIngestedUpdatedAt.set(conversation.id, seenAt);
        return count;
      });
      if (outcome === false) skipped += 1;
      else dispatched += outcome;
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.stopped) return;
        const entry = queue.shift();
        if (!entry) return;
        try {
          await runOne(entry);
        } catch (err) {
          // One bad conversation must not abort the rest of the tick.
          this.logger.error(
            `intercom: failed to process conversation ${entry.conversation.id}: ${String(err)}`,
          );
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    // Keep the watermark map bounded to what the inbox still holds open. A
    // conversation that closes and reopens gets a new updated_at, so dropping
    // it here cannot cause a missed message.
    if (this.lastIngestedUpdatedAt.size > byId.size) {
      for (const id of this.lastIngestedUpdatedAt.keys()) {
        if (!byId.has(id)) this.lastIngestedUpdatedAt.delete(id);
      }
    }

    if (dispatched > 0 || claimed > 0) {
      this.logger.info(
        `intercom: poll scanned ${byId.size} conversation(s) (${assigned.length} assigned, ${unassigned.length} unassigned) with ${workerCount} worker(s); dispatched ${dispatched} message(s), claimed ${claimed}${skipped > 0 ? `, skipped ${skipped} already in flight` : ""}${unchanged > 0 ? `, ${unchanged} unchanged` : ""}`,
      );
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
