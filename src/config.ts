import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type {
  IntercomChannelConfig,
  IntercomEscalationTarget,
  ResolvedEscalationTarget,
  ResolvedIntercomAccount,
} from "./types.js";

export const INTERCOM_CHANNEL_ID = "intercom";
export const DEFAULT_POLL_INTERVAL_SECONDS = 20;
export const DEFAULT_API_VERSION = "2.16";
/** Conversations worked on at once. Each is finished before the next is started. */
export const DEFAULT_MAX_CONCURRENT_CONVERSATIONS = 10;
/** Outbound API ceiling per minute. Conservative default; tune per workspace plan. */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 500;
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
  const rawRate = section.rateLimitPerMinute;
  const rateLimitPerMinute =
    typeof rawRate === "number" && Number.isFinite(rawRate) && rawRate >= 1
      ? Math.floor(rawRate)
      : DEFAULT_RATE_LIMIT_PER_MINUTE;
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
    allowedChannels: normalizeAllowedChannels(section.allowedChannels),
    escalationTargets: normalizeEscalationTargets(section.escalationTargets),
    createMissingTags: section.createMissingTags !== false,
    contactContext: section.contactContext !== false,
    persona: (typeof section.persona === "string" && section.persona.trim()) || DEFAULT_PERSONA,
    maxConcurrentConversations,
    rateLimitPerMinute,
    replyToExistingOnStart: section.replyToExistingOnStart === true,
  };
}

/**
 * Normalise the channel allowlist. An absent or empty list means "every
 * channel", so that leaving it unset keeps existing behaviour rather than
 * silently muting the bot everywhere.
 */
export function normalizeAllowedChannels(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  return out.length > 0 ? [...new Set(out)] : undefined;
}

/**
 * Validate the configured hand-off routes, dropping any without an id so a typo
 * in config cannot silently send conversations nowhere. Keys are lowercased for
 * case-insensitive lookup; the original spelling is kept for logs and notes.
 */
export function normalizeEscalationTargets(
  raw: Record<string, IntercomEscalationTarget> | undefined,
): Record<string, ResolvedEscalationTarget> {
  const out: Record<string, ResolvedEscalationTarget> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [name, value] of Object.entries(raw)) {
    const id = typeof value?.id === "string" ? value.id.trim() : "";
    if (!name.trim() || !id) continue;
    out[name.trim().toLowerCase()] = {
      name: name.trim(),
      id,
      // Routes are far more often teams than individuals, and assigning to a
      // single teammate who is away strands the conversation.
      type: value.type === "admin" ? "admin" : "team",
      description: typeof value.description === "string" ? value.description.trim() : undefined,
    };
  }
  return out;
}
