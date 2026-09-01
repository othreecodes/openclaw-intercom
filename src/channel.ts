import {
  createChannelPluginBase,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { IntercomClient } from "./client.js";
import { INTERCOM_CHANNEL_ID, resolveIntercomAccount } from "./config.js";
import { getIntercomInbox } from "./runtime-state.js";
import type { IntercomConversation, ResolvedIntercomAccount } from "./types.js";

export function stripIntercomTargetPrefix(raw: string): string {
  return raw.trim().replace(/^intercom:/i, "");
}

export function findLatestAdminPartId(conversation: IntercomConversation): string | undefined {
  const parts = conversation.conversation_parts?.conversation_parts ?? [];
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part.author?.type === "admin" && part.id) return part.id;
  }
  return undefined;
}

async function sendIntercomText(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text: string;
}): Promise<{ messageId: string }> {
  const account = resolveIntercomAccount(params.cfg, params.accountId);
  if (!account.configured) throw new Error("intercom: token is not configured");
  const client = new IntercomClient(account.token, account.apiVersion);
  const adminId = account.adminId ?? (await client.me()).id;
  const conversationId = stripIntercomTargetPrefix(params.to);
  const conversation = await client.reply(conversationId, adminId, params.text);
  const partId = findLatestAdminPartId(conversation);
  if (partId) {
    // Record our own reply part so poll/webhook ingest never re-ingests it.
    getIntercomInbox(params.accountId)?.markOwnPart(conversationId, partId);
  }
  return { messageId: partId ?? `${conversationId}:${Date.now()}` };
}

const intercomConfigAdapter = {
  listAccountIds: () => ["default"],
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
    resolveIntercomAccount(cfg, accountId),
  inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
    const account = resolveIntercomAccount(cfg, accountId);
    return {
      enabled: account.enabled,
      configured: account.configured,
      tokenStatus: account.configured ? "available" : "missing",
      inbound: account.inbound,
      adminId: account.adminId ?? null,
    };
  },
  isEnabled: (account: ResolvedIntercomAccount) => account.enabled,
  isConfigured: (account: ResolvedIntercomAccount) => account.configured,
  unconfiguredReason: () => "intercom: set channels.intercom.token",
};

export const intercomChannel = createChatChannelPlugin<ResolvedIntercomAccount>({
  base: {
    ...createChannelPluginBase<ResolvedIntercomAccount>({
      id: INTERCOM_CHANNEL_ID,
      meta: {
        label: "Intercom",
        selectionLabel: "Intercom",
        docsPath: "",
        blurb: "Answer Intercom conversations assigned to a bot admin.",
      },
      config: intercomConfigAdapter,
      setup: {
        applyAccountConfig: ({ cfg, input }) => ({
          ...cfg,
          channels: {
            ...(cfg as { channels?: Record<string, unknown> }).channels,
            [INTERCOM_CHANNEL_ID]: {
              ...((cfg as { channels?: Record<string, Record<string, unknown>> }).channels?.[
                INTERCOM_CHANNEL_ID
              ] ?? {}),
              ...(input as Record<string, unknown>),
            },
          },
        }),
      },
    }),
    config: intercomConfigAdapter,
    capabilities: { chatTypes: ["direct"] },
  },
  outbound: {
    base: { deliveryMode: "direct" },
    attachedResults: {
      channel: INTERCOM_CHANNEL_ID,
      sendText: async ({ cfg, to, text, accountId }) =>
        await sendIntercomText({ cfg, to, text, accountId }),
    },
  },
});
