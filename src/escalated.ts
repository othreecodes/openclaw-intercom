import fs from "node:fs";
import path from "node:path";

/** Escalated conversations untouched this long are dropped from the store. */
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_COMPACT_THRESHOLD = 500;

/**
 * Persistent set of conversation ids Sisi has escalated to a human.
 *
 * Assigning a conversation to a team clears `admin_assignee_id` but Intercom's
 * "unassigned" search only checks that one field, not `team_assignee_id` --
 * so a team-escalated conversation still comes back from
 * `searchUnassignedConversations` on every later poll. Nothing about the
 * escalation itself stops the bot from answering the next message: it stops
 * being *claimed* (isUnassigned requires the team slot empty too) but not from
 * being *ingested and replied to*. Once escalated, a conversation belongs to a
 * human until they say otherwise, so it is checked here before any polling,
 * webhook or claim logic touches the conversation again.
 *
 * Mirrors {@link IntercomDedupeStore}'s snapshot-plus-journal shape: a mark is
 * an O(1) durable append, folded into a snapshot once the journal grows past
 * `compactThreshold`.
 */
export class EscalatedStore {
  private ids = new Map<string, number>();
  private journalCount = 0;
  private readonly journalFile: string;
  private readonly ttlMs: number;
  private readonly compactThreshold: number;

  constructor(
    private readonly stateFile: string,
    private readonly logError: (message: string) => void = () => {},
    options: { ttlMs?: number; compactThreshold?: number } = {},
  ) {
    this.journalFile = `${stateFile}.journal`;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.compactThreshold = options.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
    this.load();
  }

  private load(): void {
    const now = Date.now();
    try {
      if (fs.existsSync(this.stateFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [id, seen] of Object.entries(parsed as Record<string, unknown>)) {
            const seenMs = typeof seen === "number" ? seen : now;
            if (now - seenMs > this.ttlMs) continue;
            this.ids.set(id, seenMs);
          }
        }
      }
    } catch (err) {
      this.logError(`intercom: failed to load escalated state from ${this.stateFile}: ${String(err)}`);
    }
    try {
      if (fs.existsSync(this.journalFile)) {
        for (const line of fs.readFileSync(this.journalFile, "utf8").split("\n")) {
          if (!line) continue;
          try {
            const [id, seen] = JSON.parse(line) as [string, number];
            if (typeof id !== "string") continue;
            const seenMs = typeof seen === "number" ? seen : now;
            if (now - seenMs > this.ttlMs) continue;
            this.ids.set(id, seenMs);
            this.journalCount += 1;
          } catch {
            // Torn final line after a crash: skip it, keep the rest.
          }
        }
      }
    } catch (err) {
      this.logError(`intercom: failed to replay escalated journal ${this.journalFile}: ${String(err)}`);
    }
  }

  compact(): void {
    try {
      const now = Date.now();
      for (const [id, seen] of this.ids) {
        if (now - seen > this.ttlMs) this.ids.delete(id);
      }
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.ids)), "utf8");
      fs.renameSync(tmp, this.stateFile);
      fs.rmSync(this.journalFile, { force: true });
      this.journalCount = 0;
    } catch (err) {
      this.logError(`intercom: failed to compact escalated state to ${this.stateFile}: ${String(err)}`);
    }
  }

  close(): void {
    this.compact();
  }

  isEscalated(conversationId: string): boolean {
    return this.ids.has(conversationId);
  }

  /** Marks a conversation as escalated. Idempotent. */
  markEscalated(conversationId: string): void {
    const seen = Date.now();
    this.ids.set(conversationId, seen);
    try {
      fs.mkdirSync(path.dirname(this.journalFile), { recursive: true });
      fs.appendFileSync(this.journalFile, `${JSON.stringify([conversationId, seen])}\n`, "utf8");
      this.journalCount += 1;
    } catch (err) {
      this.logError(`intercom: failed to append escalated journal ${this.journalFile}: ${String(err)}`);
    }
    if (this.journalCount >= this.compactThreshold) this.compact();
  }

  get size(): number {
    return this.ids.size;
  }
}
