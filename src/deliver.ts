import type { IntercomClient } from "./client.js";
import {
  applyConversationTags,
  isResolutionPhrase,
  parseDirectives,
  resolveEscalationRoute,
  type EscalationRoute,
  type IntercomInboxLogger,
} from "./inbox.js";
import { renderReplyHtml } from "./render.js";
import type { ResolvedIntercomAccount } from "./types.js";

/**
 * Post one agent turn to a conversation: parse `[[directive]]` syntax out of
 * the raw model text, send the cleaned reply, and apply notes/tags/escalation/
 * close.
 *
 * This is the single place that touches Intercom on the agent's behalf.
 * OpenClaw delivers an agent's output to a channel in two different ways: the
 * first reply in a conversation goes through this plugin's own inbound-dispatch
 * wrapper (`index.ts`'s `deliver` callback), but every later reply in an
 * ongoing session goes out through the channel plugin's generic outbound send
 * hook (`channel.ts`'s `sendIntercomText`) instead. A conversation that never
 * gets a second turn never exercises that second path, which is why this went
 * unnoticed: every reply after the first was posting the model's raw text --
 * unrendered Markdown and un-stripped `[[note: ...]]` / `[[escalate: ...]]` /
 * [[tag: ...]]` syntax -- straight to the customer, with no tags, notes, or
 * escalation ever actually applied. Both call sites must run every reply
 * through this same function so neither path can drift from the other again.
 */
export async function deliverAgentReply(params: {
  client: IntercomClient;
  conversationId: string;
  adminId: string;
  account: ResolvedIntercomAccount;
  raw: string | undefined;
  logger: IntercomInboxLogger;
  markOwnPart?: (conversationId: string, partId: string) => void;
  /** The customer's own last message, when known. Used only to decide whether
   * a "thanks, that's all" style reply should auto-close. Omit when unknown --
   * the model's own `[[close]]` directive still works either way. */
  customerMessageBody?: string;
  /**
   * The inbox this conversation was assigned to before Sisi ever touched it.
   * When present, escalation always hands back here, ignoring whatever queue
   * the model named -- "escalate back to the same inbox you picked it from,"
   * not a topic guess. The named-queue directive still parses and still
   * drives the fallback below, for a conversation with no known origin.
   */
  originTeam?: { id: string; type: "admin" | "team" };
}): Promise<{ postedPartId?: string; escalated: boolean }> {
  const { client, conversationId: convId, adminId, account, raw, logger, markOwnPart } = params;
  const trimmed = raw?.trim();
  const {
    text,
    close: modelClose,
    escalate,
    escalateReason,
    escalateTarget,
    notes,
    tagLists,
  } = trimmed
    ? parseDirectives(trimmed)
    : {
        text: "",
        close: false,
        escalate: false,
        escalateReason: undefined,
        escalateTarget: undefined,
        notes: [] as string[],
        tagLists: [] as string[],
      };

  let postedPartId: string | undefined;
  let escalated = false;

  // Last-resort net: even after parseDirectives, no `[[...]]`-shaped text
  // should ever reach a customer. This has already fired once for a real
  // reason (a second delivery path bypassed parseDirectives entirely, fixed
  // alongside this) -- keeping it means a future bypass fails safe instead of
  // leaking raw syntax into someone's DM again.
  const STRAY_DIRECTIVE = /\[\[\s*(?:close|note|tags?|escalate)\b[^\]]*\]\]/gi;
  let safeText = text;
  if (STRAY_DIRECTIVE.test(safeText)) {
    logger.warn(`intercom: stripped stray directive syntax before replying on ${convId}`);
    safeText = safeText.replace(STRAY_DIRECTIVE, "").trim();
  }

  // Public reply to the customer.
  if (safeText) {
    const conversation = await client.reply(convId, adminId, renderReplyHtml(safeText));
    const parts = conversation.conversation_parts?.conversation_parts ?? [];
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const part = parts[i];
      if (part.author?.type === "admin" && part.id) {
        postedPartId = part.id;
        markOwnPart?.(convId, part.id);
        break;
      }
    }
  }

  // Private internal notes (never shown to the customer).
  for (const noteBody of notes) {
    try {
      await client.note(convId, adminId, noteBody);
    } catch (err) {
      logger.warn(`intercom: failed to add note on ${convId}: ${String(err)}`);
    }
  }

  // Tagging (resolve names -> ids, creating when allowed).
  if (tagLists.length > 0) {
    try {
      const applied = await applyConversationTags(
        client,
        convId,
        adminId,
        tagLists,
        account.createMissingTags,
        logger,
      );
      if (applied.length > 0) {
        logger.info(`intercom: tagged ${convId} with ${applied.join(", ")}`);
      }
    } catch (err) {
      logger.warn(`intercom: failed to tag ${convId}: ${String(err)}`);
    }
  }

  // Escalate / hand off to a human teammate or team.
  if (escalate) {
    const route: EscalationRoute | undefined = params.originTeam
      ? { id: params.originTeam.id, type: params.originTeam.type, name: "the original inbox" }
      : resolveEscalationRoute(
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
        escalated = true;
        const where = route.name ? `${route.name} (${route.type} ${route.id})` : `${route.type} ${route.id}`;
        logger.info(`intercom: escalated ${convId} to ${where}; Sisi will not respond on it again`);
        if (route.unknownTarget) {
          logger.warn(
            `intercom: unknown escalation route "${route.unknownTarget}" on ${convId}; ` +
              `used the default assignee. Configured routes: ` +
              `${Object.keys(account.escalationTargets).join(", ") || "(none)"}`,
          );
        }
      } catch (err) {
        logger.warn(`intercom: failed to escalate ${convId}: ${String(err)}`);
      }
    } else {
      logger.warn(
        `intercom: agent requested escalation on ${convId} but neither a matching ` +
          `escalationTargets route nor channels.intercom.escalationAssigneeId is set`,
      );
    }
  }

  // Close — but not if we just escalated (a human still needs it open).
  const resolutionClose =
    params.customerMessageBody !== undefined && isResolutionPhrase(params.customerMessageBody);
  if (!escalate && account.autoClose && (modelClose || resolutionClose)) {
    try {
      await client.close(convId, adminId);
      logger.info(
        `intercom: closed conversation ${convId} (${modelClose ? "model" : "customer-resolved"})`,
      );
    } catch (err) {
      logger.warn(`intercom: failed to close conversation ${convId}: ${String(err)}`);
    }
  }

  return { postedPartId, escalated };
}
