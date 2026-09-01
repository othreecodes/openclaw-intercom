import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { IntercomChannelConfig, ResolvedIntercomAccount } from "./types.js";

export const INTERCOM_CHANNEL_ID = "intercom";
export const DEFAULT_POLL_INTERVAL_SECONDS = 20;
export const DEFAULT_API_VERSION = "2.16";

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
  };
}
