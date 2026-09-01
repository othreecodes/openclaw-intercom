import path from "node:path";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { intercomChannel } from "./src/channel.js";
import { IntercomClient } from "./src/client.js";
import { INTERCOM_CHANNEL_ID, resolveIntercomAccount } from "./src/config.js";
import { IntercomDedupeStore } from "./src/dedupe.js";
import { IntercomInbox, type InboundIntercomMessage } from "./src/inbox.js";
import { registerIntercomInbox, unregisterIntercomInbox } from "./src/runtime-state.js";
import type { ResolvedIntercomAccount } from "./src/types.js";
import { createIntercomWebhookHandler } from "./src/webhook.js";

const WEBHOOK_PATH = "/intercom/webhook";

function senderAllowed(account: ResolvedIntercomAccount, authorId: string): boolean {
  if (!account.allowFrom || account.allowFrom.length === 0) return true;
  return account.allowFrom.some((entry) => String(entry) === authorId);
}

async function startIntercomRuntime(api: OpenClawPluginApi): Promise<void> {
  const account = resolveIntercomAccount(api.config, null);
  if (!account.enabled || !account.configured) return;

  const client = new IntercomClient(account.token, account.apiVersion);
  const adminId = account.adminId ?? (await client.me()).id;
  if (!adminId) throw new Error("intercom: could not resolve adminId from GET /me");

  const stateDir = path.join(api.runtime.state.resolveStateDir(), "intercom");
  const dedupe = new IntercomDedupeStore(
    path.join(stateDir, `dedupe-${account.accountId ?? "default"}.json`),
    (message) => api.logger.error(message),
  );

  const dispatchMessage = async (message: InboundIntercomMessage): Promise<void> => {
    if (!senderAllowed(account, message.authorId)) {
      api.logger.info(
        `intercom: sender ${message.authorId} not in allowFrom; skipping part ${message.partId}`,
      );
      return;
    }
    await dispatchInboundDirectDmWithRuntime({
      runtime: api.runtime,
      cfg: api.config,
      channel: INTERCOM_CHANNEL_ID,
      channelLabel: "Intercom",
      accountId: account.accountId ?? "default",
      // One OpenClaw session per Intercom conversation: the routing peer is the
      // conversation id, so the session/conversation id is intercom:<conversationId>.
      peer: { kind: "direct", id: message.conversationId },
      senderId: message.authorId,
      senderAddress: `intercom:${message.conversationId}`,
      recipientAddress: `intercom:${adminId}`,
      conversationLabel: message.authorName
        ? `Intercom: ${message.authorName}`
        : `Intercom conversation ${message.conversationId}`,
      rawBody: message.body,
      messageId: message.partId,
      timestamp: message.createdAt ? message.createdAt * 1000 : Date.now(),
      inboundAccessAuthorized: true,
      deliver: async (payload) => {
        const text = payload.text?.trim();
        if (!text) return;
        const conversation = await client.reply(message.conversationId, adminId, text);
        const parts = conversation.conversation_parts?.conversation_parts ?? [];
        for (let i = parts.length - 1; i >= 0; i -= 1) {
          const part = parts[i];
          if (part.author?.type === "admin" && part.id) {
            inbox.markOwnPart(message.conversationId, part.id);
            break;
          }
        }
      },
      onRecordError: (err) => {
        api.logger.error(`intercom: failed to record inbound message: ${String(err)}`);
      },
      onDispatchError: (err, info) => {
        api.logger.error(`intercom: inbound dispatch failed (${info.kind}): ${String(err)}`);
      },
    });
  };

  const inbox = new IntercomInbox(client, adminId, dedupe, dispatchMessage, api.logger);
  registerIntercomInbox(account.accountId, inbox);

  if (account.inbound === "poll" || account.inbound === "both") {
    inbox.startPolling(account.pollIntervalSeconds);
    api.logger.info(
      `intercom: polling assigned conversations for admin ${adminId} every ${account.pollIntervalSeconds}s`,
    );
  }

  if (account.inbound === "webhook" || account.inbound === "both") {
    if (!account.webhookSecret) {
      api.logger.error(
        "intercom: inbound mode includes webhook but channels.intercom.webhookSecret is missing; webhook disabled",
      );
    } else {
      api.registerHttpRoute({
        path: WEBHOOK_PATH,
        auth: "plugin",
        handler: createIntercomWebhookHandler({
          secret: account.webhookSecret,
          inbox,
          logger: api.logger,
        }),
      });
      api.logger.info(`intercom: webhook registered at POST ${WEBHOOK_PATH}`);
    }
  }

  api.lifecycle.registerRuntimeLifecycle({
    id: "intercom-inbox",
    description: "Stop the Intercom poll loop and release runtime state",
    cleanup: () => {
      inbox.stop();
      unregisterIntercomInbox(account.accountId);
    },
  });
}

const intercomEntry = defineChannelPluginEntry({
  id: INTERCOM_CHANNEL_ID,
  name: "Intercom",
  description: "Intercom support channel plugin (polling + webhook inbound, auto-reply)",
  plugin: intercomChannel,
  registerFull(api) {
    void startIntercomRuntime(api).catch((err) => {
      api.logger.error(`intercom: runtime failed to start: ${String(err)}`);
    });
  },
});

export default intercomEntry;
