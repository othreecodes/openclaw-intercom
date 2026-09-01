export type IntercomInboundMode = "poll" | "webhook" | "both";

/** Raw channel config under `channels.intercom` in openclaw config. */
export interface IntercomChannelConfig {
  token?: string;
  adminId?: string;
  inbound?: IntercomInboundMode;
  pollIntervalSeconds?: number;
  webhookSecret?: string;
  apiVersion?: string;
  allowFrom?: Array<string | number>;
  enabled?: boolean;
  /** Also pick up open conversations that are unassigned (no admin/team), and
   * claim them for the bot admin before replying. Widget/Messenger visitors
   * land unassigned, so this defaults to true to auto-answer new inbound. */
  pickupUnassigned?: boolean;
  /** Close a conversation after replying when either the agent emits a
   * `[[close]]` directive (model decides) or the customer's message reads as a
   * resolution ("thanks, that's all"). Defaults to true. */
  autoClose?: boolean;
  /** Teammate (admin) or team id the bot hands off to on `[[escalate]]`. */
  escalationAssigneeId?: string;
  /** Whether escalationAssigneeId is an "admin" (teammate) or "team". Defaults to admin. */
  escalationAssigneeType?: "admin" | "team";
  /** Create tags that don't exist yet when the agent emits `[[tag: ...]]`. Defaults to true. */
  createMissingTags?: boolean;
  /** Fetch the customer's contact profile and give it to the agent as context. Defaults to true. */
  contactContext?: boolean;
  /** Voice/identity the agent adopts when replying to Intercom customers. Free-form
   * text injected into the per-message framing (e.g. who it is and how to sound).
   * Falls back to a neutral, professional support persona when unset. */
  persona?: string;
  /** How many conversations the agent may work on at the same time.
   * Each conversation is still driven to completion (reply, notes, tags, then
   * close or escalate) before that worker picks up another. Defaults to 10. */
  maxConcurrentConversations?: number;
}

export interface ResolvedIntercomAccount {
  accountId: string | null;
  enabled: boolean;
  configured: boolean;
  token: string;
  adminId?: string;
  inbound: IntercomInboundMode;
  pollIntervalSeconds: number;
  webhookSecret?: string;
  apiVersion: string;
  allowFrom?: Array<string | number>;
  pickupUnassigned: boolean;
  autoClose: boolean;
  escalationAssigneeId?: string;
  escalationAssigneeType: "admin" | "team";
  createMissingTags: boolean;
  contactContext: boolean;
  persona: string;
  maxConcurrentConversations: number;
}

export interface IntercomAdmin {
  type?: string;
  id: string;
  email?: string;
  name?: string;
}

export interface IntercomContact {
  type?: string;
  id: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  role?: string | null; // "user" | "lead"
  created_at?: number;
  last_seen_at?: number | null;
  location?: {
    city?: string | null;
    region?: string | null;
    country?: string | null;
  } | null;
  custom_attributes?: Record<string, unknown> | null;
}

export interface IntercomTag {
  type?: string;
  id: string;
  name: string;
}

export interface IntercomAuthor {
  type: string; // "user" | "admin" | "bot" | "lead" | ...
  id: string;
  name?: string | null;
  email?: string | null;
}

export interface IntercomConversationSource {
  id?: string;
  body?: string | null;
  author?: IntercomAuthor;
}

export interface IntercomConversationPart {
  id: string;
  part_type?: string;
  body?: string | null;
  created_at?: number;
  author?: IntercomAuthor;
}

export interface IntercomConversation {
  id: string;
  updated_at?: number;
  /** 0 / null when unassigned. */
  admin_assignee_id?: number | string | null;
  team_assignee_id?: number | string | null;
  source?: IntercomConversationSource;
  conversation_parts?: {
    conversation_parts?: IntercomConversationPart[];
  };
}

export interface IntercomWebhookPayload {
  topic?: string;
  data?: {
    item?: IntercomConversation;
  };
}
