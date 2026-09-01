import fs from "node:fs";
import path from "node:path";

const MAX_IDS_PER_CONVERSATION = 200;

/**
 * Persistent per-conversation dedupe of Intercom message part ids.
 * Survives restarts so poll/webhook redelivery never double-dispatches.
 */
export class IntercomDedupeStore {
  private state: Record<string, string[]> = {};

  constructor(
    private readonly stateFile: string,
    private readonly logError: (message: string) => void = () => {},
  ) {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          this.state = {};
          for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (Array.isArray(value)) this.state[key] = value.filter((v) => typeof v === "string");
          }
        }
      }
    } catch (err) {
      this.logError(`intercom: failed to load dedupe state from ${this.stateFile}: ${String(err)}`);
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state), "utf8");
      fs.renameSync(tmp, this.stateFile);
    } catch (err) {
      this.logError(`intercom: failed to save dedupe state to ${this.stateFile}: ${String(err)}`);
    }
  }

  isProcessed(conversationId: string, partId: string): boolean {
    return (this.state[conversationId] ?? []).includes(partId);
  }

  /** Marks a part processed. Returns false when it was already recorded. */
  markProcessed(conversationId: string, partId: string): boolean {
    const ids = this.state[conversationId] ?? [];
    if (ids.includes(partId)) return false;
    ids.push(partId);
    this.state[conversationId] = ids.slice(-MAX_IDS_PER_CONVERSATION);
    this.save();
    return true;
  }
}
