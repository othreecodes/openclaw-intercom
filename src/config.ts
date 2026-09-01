import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { IntercomChannelConfig, ResolvedIntercomAccount } from "./types.js";

export const INTERCOM_CHANNEL_ID = "intercom";
export const DEFAULT_POLL_INTERVAL_SECONDS = 20;
export const DEFAULT_API_VERSION = "2.16";
/** Conversations worked on at once. Each is finished before the next is started. */
export const DEFAULT_MAX_CONCURRENT_CONVERSATIONS = 10;
/** Neutral, professional support voice used when `persona` is not configured. */
export const DEFAULT_PERSONA =
  "You are the support agent for this conversation. Reply helpfully, clearly, and professionally.";

function readSection(cfg: OpenClawConfig): IntercomChannelConfig {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  return (channels?.[INTERCOM_CHANNEL_ID] ?? {}) as IntercomChannelConfig;
}

export function resolveIntercomAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedIntercomAccount {
  const section = readSection(cfg);
  const inbound = section.inbound === "webhook" || section.inbound === "both" ? section.inbound : "poll";
  const pollIntervalSeconds =
    typeof section.pollIntervalSeconds === "number" && section.pollIntervalSeconds > 0
      ? section.pollIntervalSeconds
      : DEFAULT_POLL_INTERVAL_SECONDS;
  const rawConcurrency = section.maxConcurrentConversations;
  const maxConcurrentConversations =
    typeof rawConcurrency === "number" && Number.isFinite(rawConcurrency) && rawConcurrency >= 1
      ? Math.floor(rawConcurrency)
      : DEFAULT_MAX_CONCURRENT_CONVERSATIONS;
  return {
    accountId: accountId ?? null,
    enabled: section.enabled !== false,
    configured: typeof section.token === "string" && section.token.length > 0,
    token: section.token ?? "",
    adminId: section.adminId || undefined,
    inbound,
    pollIntervalSeconds,
    webhookSecret: section.webhookSecret || undefined,
    apiVersion: section.apiVersion || DEFAULT_API_VERSION,
    allowFrom: Array.isArray(section.allowFrom) ? section.allowFrom : undefined,
    pickupUnassigned: section.pickupUnassigned !== false,
    autoClose: section.autoClose !== false,
    escalationAssigneeId: section.escalationAssigneeId || undefined,
    escalationAssigneeType: section.escalationAssigneeType === "team" ? "team" : "admin",
    createMissingTags: section.createMissingTags !== false,
    contactContext: section.contactContext !== false,
    persona: (typeof section.persona === "string" && section.persona.trim()) || DEFAULT_PERSONA,
    maxConcurrentConversations,
  };
}
