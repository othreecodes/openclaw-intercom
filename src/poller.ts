
import { IntercomClient } from "./client.js";
import { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import fs from "node:fs";
import path from "node:path";

export class IntercomPoller {
  private timer: NodeJS.Timeout | null = null;
  private state: Record<string, string[]> = {}; // convId -> processedPartIds
  private stateFile: string;

  constructor(
    private client: IntercomClient,
    private adminId: string,
    private pollInterval: number,
    private api: OpenClawPluginApi,
    stateDir: string
  ) {
    this.stateFile = path.join(stateDir, `intercom-state-${adminId}.json`);
    this.loadState();
  }

  private loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        this.state = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      }
    } catch (e) {
      this.api.logger.error("Failed to load Intercom poller state", { error: e });
    }
  }

  private saveState() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state), "utf8");
    } catch (e) {
      this.api.logger.error("Failed to save Intercom poller state", { error: e });
    }
  }

  start(processNewPart: (conversationId: string, body: string, authorId: string, partId: string) => Promise<void>) {
    this.timer = setInterval(async () => {
      try {
        const convs = await this.client.searchAssignedConversations(this.adminId);
        for (const conv of convs) {
          await this.processConversation(conv.id, processNewPart);
        }
        this.saveState();
      } catch (e) {
        this.api.logger.error("Intercom poll tick error", { error: e });
      }
    }, this.pollInterval * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async processConversation(
    id: string,
    processNewPart: (conversationId: string, body: string, authorId: string, partId: string) => Promise<void>
  ) {
    const full = await this.client.getConversation(id);
    const processed = this.state[id] || [];
    const newProcessed = [...processed];

    // Source body (initial message) dedupe
    const sourceId = `source-${id}`;
    if (!processed.includes(sourceId) && full.source.author.type === "user") {
      await processNewPart(id, full.source.body, full.source.author.id, sourceId);
      newProcessed.push(sourceId);
    }

    const parts = full.conversation_parts.conversation_parts;
    for (const part of parts) {
      if (!processed.includes(part.id) && part.author.type === "user" && part.body) {
        await processNewPart(id, part.body, part.author.id, part.id);
        newProcessed.push(part.id);
      }
    }

    // Keep state lean (only last 50 processed parts per conversation)
    this.state[id] = newProcessed.slice(-50);
  }

  isProcessed(conversationId: string, partId: string): boolean {
    return (this.state[conversationId] || []).includes(partId);
  }

  markProcessed(conversationId: string, partId: string) {
    if (!this.state[conversationId]) this.state[conversationId] = [];
    if (!this.state[conversationId].includes(partId)) {
      this.state[conversationId].push(partId);
      this.state[conversationId] = this.state[conversationId].slice(-50);
      this.saveState();
    }
  }
}
