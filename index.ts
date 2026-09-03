import path from "node:path";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { intercomChannel } from "./src/channel.js";
import { IntercomClient } from "./src/client.js";
import { INTERCOM_CHANNEL_ID, resolveIntercomAccount } from "./src/config.js";
import { IntercomDedupeStore } from "./src/dedupe.js";
import { renderReplyHtml } from "./src/render.js";
import {
  applyConversationTags,
  IntercomInbox,
  isResolutionPhrase,
  parseDirectives,
  resolveEscalationRoute,
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
        const {
          text,
          close: modelClose,
          escalate,
          escalateReason,
          escalateTarget,
          notes,
          tagLists,
        } = raw
          ? parseDirectives(raw)
          : {
              text: "",
              close: false,
              escalate: false,
              escalateReason: undefined,
              escalateTarget: undefined,
              notes: [],
              tagLists: [],
            };
        const convId = message.conversationId;

        // Public reply to the customer.
        if (text) {
          const conversation = await client.reply(convId, adminId, renderReplyHtml(text));
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
        if (tagLists.length > 0) {
          try {
            const applied = await applyConversationTags(
              client,
              convId,
              adminId,
              tagLists,
              account.createMissingTags,
              api.logger,
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
          const route = resolveEscalationRoute(
            escalateTarget,
            account.escalationTargets,
            account.escalationAssigneeId,
            account.escalationAssigneeType,
          );
          if (route) {
            try {
              // The note goes on before the assignment so whoever picks the
              // conversation up already has the reason in front of them.
              const noteLines: string[] = [];
              if (escalateReason) noteLines.push(`Escalation: ${escalateReason}`);
              if (route.unknownTarget) {
                noteLines.push(
                  `Sisi asked for the "${route.unknownTarget}" queue, which is not configured — ` +
                    `routed here instead. Reassign if this is the wrong desk.`,
                );
              }
              if (noteLines.length > 0) {
                await client.note(convId, adminId, noteLines.join("\n\n"));
              }
              await client.assignTo(convId, adminId, route.id, route.type);
              const where = route.name ? `${route.name} (${route.type} ${route.id})` : `${route.type} ${route.id}`;
              api.logger.info(`intercom: escalated ${convId} to ${where}`);
              if (route.unknownTarget) {
                api.logger.warn(
                  `intercom: unknown escalation route "${route.unknownTarget}" on ${convId}; ` +
                    `used the default assignee. Configured routes: ` +
                    `${Object.keys(account.escalationTargets).join(", ") || "(none)"}`,
                );
              }
            } catch (err) {
              api.logger.warn(`intercom: failed to escalate ${convId}: ${String(err)}`);
            }
          } else {
            api.logger.warn(
              `intercom: agent requested escalation on ${convId} but neither a matching ` +
                `escalationTargets route nor channels.intercom.escalationAssigneeId is set`,
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
    account.maxConcurrentConversations,
    account.replyToExistingOnStart,
    dedupe.isFresh,
    account.allowedChannels,
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
function escalationDirectiveHint(account: ResolvedIntercomAccount): string {
  const routes = Object.values(account.escalationTargets);
  if (routes.length === 0) {
    return `[[escalate: reason]] to hand off to a human teammate when you cannot resolve it; `;
  }
  const list = routes
    .map((r) => (r.description ? `"${r.name}" (${r.description})` : `"${r.name}"`))
    .join(", ");
  return (
    `[[escalate to <queue>: reason]] to hand off to a human when you cannot resolve it — ` +
    `pick the queue that matches the problem from: ${list}. ` +
    `Use exactly one of those names; if none fits, use [[escalate: reason]] with no queue; `
  );
}

export default intercomEntry;
