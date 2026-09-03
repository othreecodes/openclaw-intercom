import fs from "node:fs";
import path from "node:path";

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_COMPACT_THRESHOLD = 500;

/** Who a conversation was assigned to the first time Sisi ever saw it. */
export interface OriginAssignment {
  adminId?: string;
  teamId?: string;
}

/**
 * Persistent, write-once record of each conversation's assignment before Sisi
 * touched it.
 *
 * Escalating hands a conversation back to whichever inbox it came from, not to
 * a topic-guessed queue — so that inbox has to be captured before Sisi's own
 * claim (`pickupUnassigned`) can overwrite `admin_assignee_id`, and before a
 * multi-turn conversation's later polls see her own prior actions instead of
 * the original state. First sighting wins; later calls for the same
 * conversation id are no-ops. Persisted (not just in-memory) because this
 * session has shown gateway restarts happen mid-conversation, and losing the
 * origin partway through would silently fall back to guessed routing.
 */
export class OriginStore {
  private origins = new Map<string, OriginAssignment>();
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
    try {
      if (fs.existsSync(this.stateFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
            const rec = value as { origin?: OriginAssignment; seen?: number };
            if (rec?.origin) this.origins.set(id, rec.origin);
          }
        }
      }
    } catch (err) {
      this.logError(`intercom: failed to load origin state from ${this.stateFile}: ${String(err)}`);
    }
    try {
      if (fs.existsSync(this.journalFile)) {
        for (const line of fs.readFileSync(this.journalFile, "utf8").split("\n")) {
          if (!line) continue;
          try {
            const [id, origin] = JSON.parse(line) as [string, OriginAssignment];
            if (typeof id === "string" && origin && !this.origins.has(id)) {
              this.origins.set(id, origin);
              this.journalCount += 1;
            }
          } catch {
            // Torn final line after a crash: skip it, keep the rest.
          }
        }
      }
    } catch (err) {
      this.logError(`intercom: failed to replay origin journal ${this.journalFile}: ${String(err)}`);
    }
  }

  compact(): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const now = Date.now();
      const payload: Record<string, { origin: OriginAssignment; seen: number }> = {};
      for (const [id, origin] of this.origins) payload[id] = { origin, seen: now };
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
      fs.renameSync(tmp, this.stateFile);
      fs.rmSync(this.journalFile, { force: true });
      this.journalCount = 0;
    } catch (err) {
      this.logError(`intercom: failed to compact origin state to ${this.stateFile}: ${String(err)}`);
    }
  }

  close(): void {
    this.compact();
  }

  get(conversationId: string): OriginAssignment | undefined {
    return this.origins.get(conversationId);
  }

  /** Records the origin the first time it is seen; later calls are no-ops. */
  recordIfAbsent(conversationId: string, origin: OriginAssignment): void {
    if (this.origins.has(conversationId)) return;
    if (!origin.adminId && !origin.teamId) return; // nothing worth remembering
    this.origins.set(conversationId, origin);
    try {
      fs.mkdirSync(path.dirname(this.journalFile), { recursive: true });
      fs.appendFileSync(this.journalFile, `${JSON.stringify([conversationId, origin])}\n`, "utf8");
      this.journalCount += 1;
    } catch (err) {
      this.logError(`intercom: failed to append origin journal ${this.journalFile}: ${String(err)}`);
    }
    if (this.journalCount >= this.compactThreshold) this.compact();
  }

  get size(): number {
    return this.origins.size;
  }
}

/**
 * Turn a stored origin into the {id, type} shape deliverAgentReply expects.
 * Team wins over admin when both are somehow set: escalating to a person's
 * queue is far more likely to strand it than escalating to their team.
 */
export function originAsRoute(
  origin: OriginAssignment | undefined,
): { id: string; type: "admin" | "team" } | undefined {
  if (!origin) return undefined;
  if (origin.teamId) return { id: origin.teamId, type: "team" };
  if (origin.adminId) return { id: origin.adminId, type: "admin" };
  return undefined;
}
