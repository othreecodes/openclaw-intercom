import path from "node:path";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { intercomChannel } from "./src/channel.js";
import { IntercomClient } from "./src/client.js";
import { INTERCOM_CHANNEL_ID, resolveIntercomAccount } from "./src/config.js";
import { IntercomDedupeStore } from "./src/dedupe.js";
import {
  applyConversationTags,
  IntercomInbox,
  isResolutionPhrase,
  parseDirectives,
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

    // The agent reads bodyForAgent; frame who it's talking to (so it never
    // assumes the sender is David) and what inline actions it can take.
    const bodyForAgent =
      `[Intercom support chat — you are the support agent. The customer is ${customerLabel}.${profileLine} ` +
      `Reply to them as a customer; do not assume they are David or anyone on your own team, and address them by their own name (or neutrally if unnamed). ` +
      `Inline actions (put each on its own line, they are stripped before the customer sees them): ` +
      `[[close]] when the issue is fully resolved (never on the first message or while anything is open); ` +
      `[[escalate: reason]] to hand off to a human teammate when you cannot resolve it; ` +
      `[[note: text]] to leave a private internal note; ` +
      `[[tag: label1, label2]] to tag the conversation for triage.]` +
      `\n\n${message.body}`;
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
        const raw = payload.text?.trim();
        const { text, close: modelClose, escalate, escalateReason, notes, tags } = raw
          ? parseDirectives(raw)
          : { text: "", close: false, escalate: false, escalateReason: undefined, notes: [], tags: [] };
        const convId = message.conversationId;

        // Public reply to the customer.
        if (text) {
          const conversation = await client.reply(convId, adminId, text);
          const parts = conversation.conversation_parts?.conversation_parts ?? [];
          for (let i = parts.length - 1; i >= 0; i -= 1) {
            const part = parts[i];
            if (part.author?.type === "admin" && part.id) {
              inbox.markOwnPart(convId, part.id);
              break;
            }
          }
        }

        // #2 Private internal notes (never shown to the customer).
        for (const noteBody of notes) {
          try {
            await client.note(convId, adminId, noteBody);
          } catch (err) {
            api.logger.warn(`intercom: failed to add note on ${convId}: ${String(err)}`);
          }
        }

        // #3 Tagging (resolve names -> ids, creating when allowed).
        if (tags.length > 0) {
          try {
            const applied = await applyConversationTags(
              client,
              convId,
              adminId,
              tags,
              account.createMissingTags,
            );
            if (applied.length > 0) {
              api.logger.info(`intercom: tagged ${convId} with ${applied.join(", ")}`);
            }
          } catch (err) {
            api.logger.warn(`intercom: failed to tag ${convId}: ${String(err)}`);
          }
        }

        // #1 Escalate / hand off to a human teammate or team.
        if (escalate) {
          if (account.escalationAssigneeId) {
            try {
              if (escalateReason) {
                await client.note(convId, adminId, `Escalation: ${escalateReason}`);
              }
              await client.assignTo(
                convId,
                adminId,
                account.escalationAssigneeId,
                account.escalationAssigneeType,
              );
              api.logger.info(
                `intercom: escalated ${convId} to ${account.escalationAssigneeType} ${account.escalationAssigneeId}`,
              );
            } catch (err) {
              api.logger.warn(`intercom: failed to escalate ${convId}: ${String(err)}`);
            }
          } else {
            api.logger.warn(
              `intercom: agent requested escalation on ${convId} but channels.intercom.escalationAssigneeId is not set`,
            );
          }
        }

        // Close — but not if we just escalated (a human still needs it open).
        if (!escalate && account.autoClose && (modelClose || isResolutionPhrase(message.body))) {
          try {
            await client.close(convId, adminId);
            api.logger.info(
              `intercom: closed conversation ${convId} (${modelClose ? "model" : "customer-resolved"})`,
            );
          } catch (err) {
            api.logger.warn(`intercom: failed to close conversation ${convId}: ${String(err)}`);
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

  const inbox = new IntercomInbox(
    client,
    adminId,
    dedupe,
    dispatchMessage,
    api.logger,
    account.pickupUnassigned,
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
