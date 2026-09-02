import fs from "node:fs";
import path from "node:path";

const MAX_IDS_PER_CONVERSATION = 200;
/** Conversations untouched for this long are dropped from the store. */
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Compact once the journal has at least this many appended records. */
const DEFAULT_COMPACT_THRESHOLD = 500;

interface ConversationRecord {
  /** Part ids, oldest first, capped at MAX_IDS_PER_CONVERSATION. */
  ids: string[];
  /** Last time this conversation was touched, epoch ms. */
  seen: number;
}

type Snapshot = { version: 2; conversations: Record<string, ConversationRecord> };

export interface IntercomDedupeOptions {
  /** Drop conversations untouched for longer than this. Default 30 days. */
  ttlMs?: number;
  /** Compact the journal into the snapshot after this many appends. Default 500. */
  compactThreshold?: number;
}

/**
 * Persistent per-conversation dedupe of Intercom message part ids.
 * Survives restarts so poll/webhook redelivery never double-dispatches.
 *
 * Durability matters here: a part must be recorded before the message is acted
 * on, or a crash mid-dispatch can produce a second reply to a customer. But the
 * previous implementation rewrote the entire state file synchronously for every
 * part, which is O(total state) of blocking I/O per message and grew without
 * bound because conversation keys were never evicted.
 *
 * So this uses a snapshot plus an append-only journal:
 *
 *  - `markProcessed` appends one short line and returns. The write is durable
 *    immediately and costs O(1) regardless of how much history is tracked.
 *  - Once the journal passes `compactThreshold` records it is folded into a
 *    fresh snapshot and truncated, pruning expired conversations on the way.
 *  - `load` reads the snapshot then replays the journal.
 *
 * Membership lookups use a Set per conversation, so marking is O(1) rather than
 * a linear scan.
 */
export class IntercomDedupeStore {
  private conversations = new Map<string, { ids: string[]; set: Set<string>; seen: number }>();
  private journalCount = 0;
  /** True when no persisted state existed at construction: a first-ever run. */
  readonly isFresh: boolean;
  private readonly journalFile: string;
  private readonly ttlMs: number;
  private readonly compactThreshold: number;

  constructor(
    private readonly stateFile: string,
    private readonly logError: (message: string) => void = () => {},
    options: IntercomDedupeOptions = {},
  ) {
    this.journalFile = `${stateFile}.journal`;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.compactThreshold = options.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
    this.isFresh = !fs.existsSync(stateFile) && !fs.existsSync(this.journalFile);
    this.load();
  }

  private touch(conversationId: string, partId: string, seen: number): void {
    let record = this.conversations.get(conversationId);
    if (!record) {
      record = { ids: [], set: new Set(), seen };
      this.conversations.set(conversationId, record);
    }
    if (!record.set.has(partId)) {
      record.ids.push(partId);
      record.set.add(partId);
      if (record.ids.length > MAX_IDS_PER_CONVERSATION) {
        const dropped = record.ids.splice(0, record.ids.length - MAX_IDS_PER_CONVERSATION);
        for (const id of dropped) record.set.delete(id);
      }
    }
    if (seen > record.seen) record.seen = seen;
  }

  private load(): void {
    const now = Date.now();
    try {
      if (fs.existsSync(this.stateFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          const entries =
            record.version === 2 && record.conversations && typeof record.conversations === "object"
              ? Object.entries(record.conversations as Record<string, unknown>)
              : // v1: { conversationId: string[] } — adopt with a fresh timestamp
                // so nothing is evicted purely for lacking a seen time.
                Object.entries(record);

          for (const [conversationId, value] of entries) {
            let ids: string[] = [];
            let seen = now;
            if (Array.isArray(value)) {
              ids = value.filter((v): v is string => typeof v === "string");
            } else if (value && typeof value === "object") {
              const rec = value as Partial<ConversationRecord>;
              ids = Array.isArray(rec.ids)
                ? rec.ids.filter((v): v is string => typeof v === "string")
                : [];
              seen = typeof rec.seen === "number" ? rec.seen : now;
            }
            if (ids.length === 0 || now - seen > this.ttlMs) continue;
            for (const id of ids.slice(-MAX_IDS_PER_CONVERSATION)) {
              this.touch(conversationId, id, seen);
            }
          }
        }
      }
    } catch (err) {
      this.logError(`intercom: failed to load dedupe state from ${this.stateFile}: ${String(err)}`);
    }

    // Replay anything appended since the last compaction.
    try {
      if (fs.existsSync(this.journalFile)) {
        const lines = fs.readFileSync(this.journalFile, "utf8").split("\n");
        for (const line of lines) {
          if (!line) continue;
          try {
            const [conversationId, partId, seenRaw] = JSON.parse(line) as [string, string, number];
            if (typeof conversationId !== "string" || typeof partId !== "string") continue;
            const seen = typeof seenRaw === "number" ? seenRaw : now;
            if (now - seen > this.ttlMs) continue;
            this.touch(conversationId, partId, seen);
            this.journalCount += 1;
          } catch {
            // A torn final line after a crash: skip it, keep the rest.
          }
        }
      }
    } catch (err) {
      this.logError(`intercom: failed to replay dedupe journal ${this.journalFile}: ${String(err)}`);
    }
  }

  /** Fold the journal into a fresh snapshot and prune expired conversations. */
  compact(): void {
    try {
      const now = Date.now();
      for (const [conversationId, record] of this.conversations) {
        if (now - record.seen > this.ttlMs) this.conversations.delete(conversationId);
      }
      const payload: Snapshot = { version: 2, conversations: {} };
      for (const [conversationId, record] of this.conversations) {
        payload.conversations[conversationId] = { ids: record.ids, seen: record.seen };
      }
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
      fs.renameSync(tmp, this.stateFile);
      // Snapshot is durable, so the journal it superseded can go.
      fs.rmSync(this.journalFile, { force: true });
      this.journalCount = 0;
    } catch (err) {
      this.logError(`intercom: failed to compact dedupe state to ${this.stateFile}: ${String(err)}`);
    }
  }

  /** Compact and release resources. Call on channel shutdown. */
  close(): void {
    this.compact();
  }

  isProcessed(conversationId: string, partId: string): boolean {
    return this.conversations.get(conversationId)?.set.has(partId) ?? false;
  }

  /** Marks a part processed. Returns false when it was already recorded. */
  markProcessed(conversationId: string, partId: string): boolean {
    const record = this.conversations.get(conversationId);
    if (record?.set.has(partId)) {
      // Already known. Keep active conversations from ageing out, but there is
      // nothing new to persist.
      record.seen = Date.now();
      return false;
    }

    const seen = Date.now();
    this.touch(conversationId, partId, seen);

    try {
      fs.mkdirSync(path.dirname(this.journalFile), { recursive: true });
      fs.appendFileSync(this.journalFile, `${JSON.stringify([conversationId, partId, seen])}\n`, "utf8");
      this.journalCount += 1;
    } catch (err) {
      this.logError(`intercom: failed to append dedupe journal ${this.journalFile}: ${String(err)}`);
    }

    if (this.journalCount >= this.compactThreshold) this.compact();
    return true;
  }

  /** Number of tracked conversations. Exposed for diagnostics and tests. */
  get size(): number {
    return this.conversations.size;
  }
}
