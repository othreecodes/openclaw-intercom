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
}

export interface IntercomAdmin {
  type?: string;
  id: string;
  email?: string;
  name?: string;
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
