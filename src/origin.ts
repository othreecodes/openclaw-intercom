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

  /**
   * Fill in a team we did not know at first sighting.
   *
   * Intercom assigns the team a moment after the conversation appears, so the
   * poll often captures it team-less. Recording the team the first time we do
   * see it keeps later turns from re-fetching it.
   */
  recordTeamIfAbsent(conversationId: string, teamId: string): void {
    const current = this.origins.get(conversationId);
    if (current?.teamId) return;
    const next: OriginAssignment = { ...(current ?? {}), teamId };
    this.origins.set(conversationId, next);
    try {
      fs.mkdirSync(path.dirname(this.journalFile), { recursive: true });
      fs.appendFileSync(this.journalFile, JSON.stringify([conversationId, next]) + "\n", "utf8");
      this.journalCount += 1;
    } catch (err) {
      this.logError(
        "intercom: failed to append origin journal " + this.journalFile + ": " + String(err),
      );
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
  nonRoutableAdminIds?: ReadonlySet<string>,
): { id: string; type: "admin" | "team" } | undefined {
  if (!origin) return undefined;
  if (origin.teamId) return { id: origin.teamId, type: "team" };
  // An Operator/bot admin cannot work an inbox, so handing a conversation back
  // to one strands it. Dropping the route here (rather than only at capture
  // time) also neutralises origins already written to disk by earlier builds.
  if (origin.adminId && !nonRoutableAdminIds?.has(origin.adminId)) {
    return { id: origin.adminId, type: "admin" };
  }
  return undefined;
}


/**
 * Work out which inbox an escalation should go back to.
 *
 * The rule is: hand the conversation back to the team inbox it was picked up
 * from. The complication is timing -- Intercom parks new inbound on the
 * Operator bot for a beat before a workflow assigns the team, and the poll
 * routinely sees it inside that window, so the origin recorded at first
 * sighting often has no team in it. Rather than give up and let the caller
 * guess a queue by topic, re-read the conversation: by escalation time the
 * workflow has almost always set the team, and that team is where it came from.
 *
 * Order: remembered team, then the conversation's current team, then a real
 * human admin, then nothing (the caller falls back to configured targets).
 */
export async function resolveOriginRoute(params: {
  conversationId: string;
  recordedOrigin: OriginAssignment | undefined;
  nonRoutableAdminIds?: ReadonlySet<string>;
  getConversation: (id: string) => Promise<{ team_assignee_id?: string | number | null }>;
  store?: { recordTeamIfAbsent(conversationId: string, teamId: string): void };
  logError?: (message: string) => void;
}): Promise<{ id: string; type: "admin" | "team" } | undefined> {
  const { conversationId, recordedOrigin, nonRoutableAdminIds, getConversation, store } = params;

  if (recordedOrigin?.teamId) return { id: recordedOrigin.teamId, type: "team" };

  try {
    const live = await getConversation(conversationId);
    const teamId = live?.team_assignee_id ? String(live.team_assignee_id) : undefined;
    if (teamId) {
      store?.recordTeamIfAbsent(conversationId, teamId);
      return { id: teamId, type: "team" };
    }
  } catch (err) {
    params.logError?.(
      "intercom: could not re-read " + conversationId + " for its origin team: " + String(err),
    );
  }

  const adminId = recordedOrigin?.adminId;
  if (adminId && !nonRoutableAdminIds?.has(adminId)) return { id: adminId, type: "admin" };
  return undefined;
}
