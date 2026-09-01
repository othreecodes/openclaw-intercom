
import { IntercomAdmin, IntercomConversation, IntercomFullConversation } from "./types.js";

export class IntercomClient {
  constructor(
    private token: string,
    private apiVersion: string = "2.16"
  ) {}

  private async request(method: string, path: string, body?: any) {
    const response = await fetch(`https://api.intercom.io${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Intercom-Version": this.apiVersion,
        "Accept": "application/json",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Intercom API error (${response.status}): ${error}`);
    }

    return response.json();
  }

  async me(): Promise<IntercomAdmin> {
    return this.request("GET", "/me");
  }

  async searchAssignedConversations(adminId: string): Promise<IntercomConversation[]> {
    const data = await this.request("POST", "/conversations/search", {
      query: {
        operator: "AND",
        value: [
          { field: "admin_assignee_id", operator: "=", value: adminId },
          { field: "open", operator: "=", value: true }
        ]
      },
      sort: { field: "updated_at", order: "descending" }
    });
    return data.conversations || [];
  }

  async getConversation(id: string): Promise<IntercomFullConversation> {
    return this.request("GET", `/conversations/${id}`);
  }

  async reply(conversationId: string, adminId: string, body: string): Promise<void> {
    await this.request("POST", `/conversations/${conversationId}/reply`, {
      message_type: "comment",
      type: "admin",
      admin_id: adminId,
      body
    });
  }
}
