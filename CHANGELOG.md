# Changelog

## 1.0.4

### Fixed

- **The bot no longer answers messages a human teammate already handled.** A
  conversation that spent time with human support and later re-entered the
  bot's scope looked entirely unread to it, and it re-litigated an
  already-resolved problem past the customer saying goodbye. Customer messages
  at or before the last human teammate reply are now absorbed as handled;
  workflow bots (like the "replies in under 3m" auto-responder) deliberately do
  not count as teammates. ([#31](https://github.com/othreecodes/openclaw-intercom/pull/31))


## 1.0.3

### Fixed

- **A directive leaked to a customer on follow-up turns.** OpenClaw delivers
  replies after a conversation's first turn through a second send hook that
  bypassed directive parsing, HTML rendering, tags, notes and escalation
  entirely. Both paths now share one pipeline, with a defensive strip of any
  `[[...]]`-shaped text as a last resort. ([#21](https://github.com/othreecodes/openclaw-intercom/pull/21))
- **Escalating now actually stops the bot.** Team-escalated conversations kept
  matching Intercom's admin-only "unassigned" search and were re-answered on
  every poll. A persistent escalated-set makes a conversation inert to poll,
  webhook and claim once handed to a human, and replies already queued in the
  agent runtime are dropped at delivery. ([#22](https://github.com/othreecodes/openclaw-intercom/pull/22), [#24](https://github.com/othreecodes/openclaw-intercom/pull/24))
- **A message backlog no longer causes a reply storm.** All pending customer
  messages in one cycle coalesce into a single agent turn with full context,
  instead of one reply per stale message. ([#24](https://github.com/othreecodes/openclaw-intercom/pull/24))
- **The bot can see customer images.** Messenger-style uploads and Instagram's
  inline `<img>` bodies are extracted, downloaded from the CDN and described
  through the runtime's image understanding; image-only messages (empty body)
  are no longer dropped. Webhook payloads are treated as notifications and the
  canonical conversation is fetched, since the payload flattens image tags
  away. ([#25](https://github.com/othreecodes/openclaw-intercom/pull/25), [#26](https://github.com/othreecodes/openclaw-intercom/pull/26), [#27](https://github.com/othreecodes/openclaw-intercom/pull/27), [#28](https://github.com/othreecodes/openclaw-intercom/pull/28))

### Changed

- **Escalation returns a conversation to its original inbox.** A persistent
  write-once record captures where each conversation lived before the bot
  touched it, and escalation always hands back there. Named-queue routing
  (`escalationTargets`) remains as the fallback when no origin is known.
  ([#23](https://github.com/othreecodes/openclaw-intercom/pull/23))

### Added

- CI: tests and typecheck run on every PR; pushing a `v*` tag publishes to
  ClawHub after verifying the tag matches `package.json` and extracting the
  changelog section for the release.


## 1.0.2

Republish of 1.0.1. The 1.0.1 publish to ClawHub failed inside the registry's
publish gate after the version record had been created, leaving the version
number claimed but with no artifact and `latest` still pointing at 1.0.0. The
version could then neither be installed nor re-published, so the same code ships
as 1.0.2. No code changes from 1.0.1.

## 1.0.1

### Fixed

- **Tag names containing commas were shredded into new tags.** `[[tag: ...]]`
  split on commas, but a comma is also legal inside an Intercom tag name, so
  tagging with an existing `How to-s (save, invest, etc.)` silently created and
  applied three junk tags instead. Directive bodies are now resolved against the
  workspace vocabulary before being split. ([#14](https://github.com/othreecodes/openclaw-intercom/pull/14))
- **Unknown tag names are logged rather than dropped silently** when
  `createMissingTags` is off. ([#14](https://github.com/othreecodes/openclaw-intercom/pull/14))
- **Lists, bold and line breaks were lost in replies.** Intercom's conversation
  body is an HTML field and replies were posted as raw text, so numbered steps
  and bullets arrived as literal `1.` and `-` characters. Replies are now
  rendered from a small Markdown subset. ([#16](https://github.com/othreecodes/openclaw-intercom/pull/16))
- **The channel card showed a question mark**, which read as an unsupported
  channel. Now uses a messaging symbol, matching the built-in channels.
  ([#18](https://github.com/othreecodes/openclaw-intercom/pull/18))

### Added

- **`escalationTargets`** — named hand-off queues the agent picks between with
  `[[escalate to payments: reason]]`. A queue the agent invents is not followed:
  it falls back to `escalationAssigneeId`, logs a warning and leaves an internal
  note saying which queue was wanted. ([#15](https://github.com/othreecodes/openclaw-intercom/pull/15))
- **`allowedChannels`** — restrict which Intercom surfaces the bot answers, e.g.
  `["messenger", "email"]`. Omitted or empty answers every channel, so existing
  deployments are unchanged. Conversations on other channels are left untouched
  and, importantly, not claimed. ([#17](https://github.com/othreecodes/openclaw-intercom/pull/17))

### Notes

- No breaking changes. Both new options are optional and default to previous
  behaviour.
- `IntercomConversationSource` now types `type`, `delivered_as` and `url`, which
  Intercom already returns. `source.url` is the page the customer was on when
  they opened the chat.

## 1.0.0

Initial release.
