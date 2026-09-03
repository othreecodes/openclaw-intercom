# Changelog

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
