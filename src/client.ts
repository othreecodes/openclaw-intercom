import type { IntercomAdmin, IntercomConversation } from "./types.js";

const BASE_URL = "https://api.intercom.io";
const MAX_RETRY_AFTER_SECONDS = 60;

export class IntercomApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    path: string,
  ) {
    super(`Intercom API error ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = "IntercomApiError";
  }
}

export class IntercomClient {
  constructor(
    private readonly token: string,
    private readonly apiVersion: string = "2.16",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const response = await this.fetchImpl(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Intercom-Version": this.apiVersion,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (response.status === 429 && !retried) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? "1");
      const waitSeconds = Math.min(
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1,
        MAX_RETRY_AFTER_SECONDS,
      );
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      return this.request<T>(method, path, body, true);
    }

    if (!response.ok) {
      throw new IntercomApiError(response.status, await response.text(), path);
    }
    return (await response.json()) as T;
  }

  me(): Promise<IntercomAdmin> {
    return this.request<IntercomAdmin>("GET", "/me");
  }

  async searchAssignedConversations(adminId: string): Promise<IntercomConversation[]> {
    const data = await this.request<{ conversations?: IntercomConversation[] }>(
      "POST",
      "/conversations/search",
      {
        query: {
          operator: "AND",
          value: [
            { field: "admin_assignee_id", operator: "=", value: adminId },
            { field: "open", operator: "=", value: true },
          ],
        },
        sort_by: "updated_at",
        sort_order: "desc",
      },
    );
    return data.conversations ?? [];
  }

  getConversation(id: string): Promise<IntercomConversation> {
    return this.request<IntercomConversation>("GET", `/conversations/${encodeURIComponent(id)}`);
  }

  reply(conversationId: string, adminId: string, body: string): Promise<IntercomConversation> {
    return this.request<IntercomConversation>(
      "POST",
      `/conversations/${encodeURIComponent(conversationId)}/reply`,
      {
        message_type: "comment",
        type: "admin",
        admin_id: adminId,
        body,
      },
    );
  }
}
