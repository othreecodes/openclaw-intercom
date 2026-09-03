import {
  createChannelPluginBase,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { IntercomClient } from "./client.js";
import { INTERCOM_CHANNEL_ID, resolveIntercomAccount } from "./config.js";
import { deliverAgentReply } from "./deliver.js";
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
  const inbox = getIntercomInbox(params.accountId);
  // Every reply after the first turn of a conversation is delivered through
  // this generic outbound-send hook rather than index.ts's inbound-dispatch
  // wrapper, so this has to run the exact same directive parsing, rendering,
  // tagging and escalation pipeline -- see deliverAgentReply's own comment for
  // why that matters. Skipping it here is what let raw [[directive]] syntax
  // reach a customer once before.
  const { postedPartId, escalated } = await deliverAgentReply({
    client,
    conversationId,
    adminId,
    account,
    raw: params.text,
    logger: inbox?.logger ?? console,
    markOwnPart: inbox ? (id, partId) => inbox.markOwnPart(id, partId) : undefined,
  });
  if (escalated) inbox?.escalated?.markEscalated(conversationId);
  return { messageId: postedPartId ?? `${conversationId}:${Date.now()}` };
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
        detailLabel: "Intercom support inbox",
        // SF Symbol shown on the channel card. Without one the Control UI
        // falls back to the first two letters of the id ("IN").
        //
        // A brand logo is not an option: ChannelUiMetaSchema is a closed object
        // of {id, label, detailLabel, systemImage}, so every channel uses a
        // generic symbol — Discord "bubble.left.and.bubble.right", LINE
        // "message.fill", Google Chat "message.badge". Matching that convention
        // with a filled bubble, which also reads closest to Intercom's own
        // messenger mark. The previous "questionmark.bubble" looked like an
        // unsupported or unknown channel rather than a messaging one.
        systemImage: "message.fill",
        // An empty docsPath makes the Gateway log the channel as having
        // incomplete metadata and fill the field in itself.
        docsPath: "https://github.com/othreecodes/openclaw-intercom#readme",
        docsLabel: "Intercom plugin docs",
        blurb:
          "Answer Intercom conversations as a support teammate: polling or webhook inbound, " +
          "auto-reply, and inline close, escalate, note and tag actions.",
        aliases: ["intercom.io"],
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
    /**
     * Report whether the channel is actually live.
     *
     * Without this the Gateway never sees the channel leave "stopped", and it
     * refuses to admit that channel's tasks: every inbound message fails with
     * GatewayDrainingError once the health monitor's startup grace expires,
     * roughly a minute after boot. `channels.start` cannot help, because a
     * channel with no status adapter reports "does not support start".
     *
     * The inbox is registered in runtime-state once polling and/or the webhook
     * route are wired up, and unregistered on cleanup, so its presence is the
     * liveness signal.
     */
    status: {
      buildAccountSnapshot: ({ account, runtime }) => {
        const live = Boolean(getIntercomInbox(account.accountId));
        return {
          ...(runtime ?? {}),
          accountId: account.accountId ?? "default",
          name: runtime?.name,
          enabled: account.enabled,
          configured: account.configured,
          running: live,
          connected: live,
          statusState: live ? "running" : "stopped",
        };
      },
    },
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
