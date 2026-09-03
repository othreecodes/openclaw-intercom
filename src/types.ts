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
  /** Teammate (admin) or team id the bot hands off to on `[[escalate]]`. Also the
   * fallback when the agent names a route that is not in {@link escalationTargets}. */
  escalationAssigneeId?: string;
  /** Whether escalationAssigneeId is an "admin" (teammate) or "team". Defaults to admin. */
  escalationAssigneeType?: "admin" | "team";
  /**
   * Intercom surfaces the bot answers on, e.g. ["messenger", "email"]. Omit or
   * leave empty to answer every channel. Conversations on any other channel are
   * left untouched — not claimed, not replied to — so a human still owns them.
   */
  allowedChannels?: string[];
  /**
   * Named hand-off routes the agent may pick between with
   * `[[escalate to <name>: reason]]`. Keys are the names the agent uses; they are
   * matched case-insensitively. A route the agent invents is never followed —
   * it falls back to {@link escalationAssigneeId} and is logged.
   */
  escalationTargets?: Record<string, IntercomEscalationTarget>;
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
  /** Ceiling on outbound Intercom API requests per minute. Defaults to 500. */
  rateLimitPerMinute?: number;
  /** Answer conversations that already existed the first time this channel ran.
   * Defaults to false: otherwise a first run replies to the whole open inbox. */
  replyToExistingOnStart?: boolean;
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
  allowedChannels?: string[];
  escalationTargets: Record<string, ResolvedEscalationTarget>;
  createMissingTags: boolean;
  contactContext: boolean;
  persona: string;
  maxConcurrentConversations: number;
  rateLimitPerMinute: number;
  replyToExistingOnStart: boolean;
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
  /** Delivery surface, e.g. "conversation" (Messenger), "email", "push". */
  type?: string;
  /** How it arrived: "customer_initiated", "admin_initiated", "automated". */
  delivered_as?: string;
  /** Page the customer was on when they opened the chat, when known. */
  url?: string | null;
  attachments?: IntercomAttachment[];
}

/** A file the customer attached — on Instagram, almost always a screenshot. */
export interface IntercomAttachment {
  type?: string;
  name?: string;
  content_type?: string;
  url?: string;
  filesize?: number;
}

export interface IntercomConversationPart {
  id: string;
  part_type?: string;
  body?: string | null;
  created_at?: number;
  author?: IntercomAuthor;
  attachments?: IntercomAttachment[];
}

export interface IntercomConversation {
  id: string;
  updated_at?: number;
  /** 0 / null when unassigned. */
  admin_assignee_id?: number | string | null;
  team_assignee_id?: number | string | null;
  source?: IntercomConversationSource;
  /** Surface the conversation arrived on, and where it is now if it moved. */
  channel?: {
    initial?: string | null;
    current?: string | null;
  };
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

/** One named hand-off route, as written in config. */
export interface IntercomEscalationTarget {
  /** Intercom admin or team id to assign to. */
  id: string;
  /** Whether `id` names an "admin" (teammate) or a "team". Defaults to team. */
  type?: "admin" | "team";
  /** Shown to the agent so it can pick the right route. Keep it about the work,
   * not the people (e.g. "failed or missing payments"). */
  description?: string;
}

/** A validated route, keyed by its lowercased name. */
export interface ResolvedEscalationTarget {
  /** The name as written in config, preserved for logs and notes. */
  name: string;
  id: string;
  type: "admin" | "team";
  description?: string;
}
