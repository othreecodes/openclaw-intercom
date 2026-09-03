import path from "node:path";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { intercomChannel } from "./src/channel.js";
import { IntercomClient } from "./src/client.js";
import { INTERCOM_CHANNEL_ID, resolveIntercomAccount } from "./src/config.js";
import { IntercomDedupeStore } from "./src/dedupe.js";
import { EscalatedStore } from "./src/escalated.js";
import { OriginStore, originAsRoute } from "./src/origin.js";
import { deliverAgentReply } from "./src/deliver.js";
import { describeAttachments, downloadToFile } from "./src/media.js";
import {
  IntercomInbox,
  summarizeContact,
  type InboundIntercomMessage,
} from "./src/inbox.js";
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

  const client = new IntercomClient(account.token, account.apiVersion, undefined, {
    rateLimitPerMinute: account.rateLimitPerMinute,
  });
  const adminId = account.adminId ?? (await client.me()).id;
  if (!adminId) throw new Error("intercom: could not resolve adminId from GET /me");

  const stateDir = path.join(api.runtime.state.resolveStateDir(), "intercom");
  const dedupe = new IntercomDedupeStore(
    path.join(stateDir, `dedupe-${account.accountId ?? "default"}.json`),
    (message) => api.logger.error(message),
  );
  const escalated = new EscalatedStore(
    path.join(stateDir, `escalated-${account.accountId ?? "default"}.json`),
    (message) => api.logger.error(message),
  );
  const origin = new OriginStore(
    path.join(stateDir, `origin-${account.accountId ?? "default"}.json`),
    (message) => api.logger.error(message),
  );

  const dispatchMessage = async (message: InboundIntercomMessage): Promise<void> => {
    if (!senderAllowed(account, message.authorId)) {
      api.logger.info(
        `intercom: sender ${message.authorId} not in allowFrom; skipping part ${message.partId}`,
      );
      return;
    }
    // Identify the customer for the agent. Named users get their name (+ email);
    // anonymous widget leads have neither, so say so explicitly — otherwise the
    // routed agent falls back to its own persona and misaddresses the customer.
    const customerName = message.authorName?.trim();
    const customerEmail = message.authorEmail?.trim();
    const customerLabel = customerName
      ? customerEmail
        ? `${customerName} <${customerEmail}>`
        : customerName
      : customerEmail
        ? `Intercom visitor <${customerEmail}>`
        : "an anonymous Intercom visitor (no name on file)";
    const conversationLabel = customerName
      ? `${customerName} (Intercom)`
      : customerEmail
        ? `${customerEmail} (Intercom)`
        : `Intercom visitor ${message.conversationId}`;

    // #4 Contact context: give the agent the customer's profile before it replies.
    let profileLine = "";
    if (account.contactContext && message.authorId) {
      try {
        const summary = summarizeContact(await client.getContact(message.authorId));
        if (summary) profileLine = ` Known profile — ${summary}.`;
      } catch (err) {
        api.logger.warn(
          `intercom: contact lookup failed for ${message.authorId}: ${String(err)}`,
        );
      }
    }

    // Screenshots are half of Instagram support. Describe them through the
    // runtime's media understanding so the agent can actually read a payment
    // receipt or an error screen, instead of denying an image ever arrived.
    let attachmentContext = "";
    if (message.attachments?.length) {
      attachmentContext = await describeAttachments({
        attachments: message.attachments,
        logger: api.logger,
        download: downloadToFile,
        describe: async (filePath) => {
          const result = await api.runtime.mediaUnderstanding.describeImageFile({
            filePath,
            cfg: api.config,
          });
          return typeof result === "string" ? result : ((result as { text?: string })?.text ?? "");
        },
      });
    }

    // The agent reads bodyForAgent; the persona (configurable) sets the voice,
    // then we pin who it's talking to (so it never assumes the sender is David)
    // and what inline actions it can take.
    const bodyForAgent =
      `[Intercom support chat. ${account.persona} The customer is ${customerLabel}.${profileLine} ` +
      `Do not assume the customer is David or anyone on your own team; address them by their own name (or neutrally if unnamed). ` +
      `Inline actions (put each on its own line, they are stripped before the customer sees them): ` +
      `[[close]] when the issue is fully resolved (never on the first message or while anything is open); ` +
      escalationDirectiveHint(account) +
      `[[note: text]] to leave a private internal note; ` +
      `[[tag: label]] to tag the conversation for triage — use one directive per tag, ` +
      `and use a tag name exactly as it already exists in the workspace.]` +
      `\n\n${[message.body, attachmentContext].filter(Boolean).join("\n\n")}`;
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
      conversationLabel,
      rawBody: message.body,
      bodyForAgent,
      messageId: message.partId,
      timestamp: message.createdAt ? message.createdAt * 1000 : Date.now(),
      inboundAccessAuthorized: true,
      deliver: async (payload) => {
        // An earlier turn may have escalated while this one was still queued in
        // the agent runtime. The ingest guard cannot see queued turns, so this
        // is the second half of "stop responding once escalated": first
        // escalation wins, everything still in the pipe is dropped.
        if (escalated.isEscalated(message.conversationId)) {
          api.logger.info(
            `intercom: dropping queued reply on ${message.conversationId}; already escalated to a human`,
          );
          return;
        }
        const recordedOrigin = origin.get(message.conversationId);
        const result = await deliverAgentReply({
          client,
          conversationId: message.conversationId,
          adminId,
          account,
          raw: payload.text,
          logger: api.logger,
          markOwnPart: (convId, partId) => inbox.markOwnPart(convId, partId),
          customerMessageBody: message.body,
          // Not our own admin id: escalating "back" to ourselves would not
          // hand the conversation to a human at all.
          originTeam:
            recordedOrigin?.adminId === adminId ? undefined : originAsRoute(recordedOrigin),
        });
        if (result.escalated) escalated.markEscalated(message.conversationId);
      },
      onRecordError: (err) => {
        api.logger.error(`intercom: failed to record inbound message: ${String(err)}`);
      },
      onDispatchError: (err, info) => {
        api.logger.error(`intercom: inbound dispatch failed (${info.kind}): ${String(err)}`);
      },
    });
  };

  const inbox = new IntercomInbox(
    client,
    adminId,
    dedupe,
    dispatchMessage,
    api.logger,
    account.pickupUnassigned,
    account.maxConcurrentConversations,
    account.replyToExistingOnStart,
    dedupe.isFresh,
    account.allowedChannels,
    escalated,
    origin,
  );
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
      // Fold the dedupe journal into its snapshot so the next start replays less.
      dedupe.close();
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

/**
 * Describe the escalate directive to the agent, listing the configured routes so
 * it picks a real one. Falls back to the unrouted form when no routes are set.
 */
/**
 * Escalation always hands the conversation back to whichever inbox it was
 * already on -- Sisi does not choose the destination, so the agent is not
 * asked to name one. Naming a queue used to change the routing; now it would
 * only be quietly ignored, which is worse than not offering it.
 */
function escalationDirectiveHint(_account: ResolvedIntercomAccount): string {
  return `[[escalate: reason]] to hand off to a human teammate when you cannot resolve it; `;
}

export default intercomEntry;
