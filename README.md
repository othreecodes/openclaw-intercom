# OpenClaw Intercom Plugin

This plugin allows an OpenClaw agent to act as a support teammate in Intercom.io.

## Features
- **Hybrid Inbound**: Polling, Webhooks, or Both.
- **Deduplication**: Unified path for poll/webhook messages using conversation part IDs.
- **Auto-Reply**: Responds to customers as admin comments.
- **Session Threading**: Maps Intercom conversations to OpenClaw sessions.
- **Unassigned Pickup**: Answers open conversations that land unassigned (Messenger/widget visitors) and claims them for the bot admin.
- **Customer Identity**: Carries the customer's name/email (and, optionally, their full contact profile) into the agent so replies address the real customer instead of falling back to the operator's persona.
- **Inline Agent Actions**: The agent can drive Intercom from its reply text using directives that are stripped before the customer sees them:
  - `[[close]]` — close the conversation once the issue is fully resolved.
  - `[[escalate: reason]]` — hand off to a human teammate or team (escalated conversations are never auto-closed).
  - `[[note: text]]` — leave a private internal note (not visible to the customer).
  - `[[tag: label1, label2]]` — tag the conversation for triage (missing tags can be auto-created).
- **Auto-Close on Resolution**: Closes a conversation after replying when the agent emits `[[close]]` or the customer's message reads as resolved ("thanks, that's all").

## Installation
Run the following command in your OpenClaw workspace:
```bash
openclaw plugins install /Users/david/clawd/plugins/openclaw-intercom
```

## Configuration
Add the following to your `openclaw.json`:

```json
{
  "channels": {
    "intercom": {
      "token": "YOUR_ACCESS_TOKEN",
      "adminId": "OPTIONAL_ADMIN_ID",
      "pollIntervalSeconds": 20,
      "inbound": "poll",
      "webhookSecret": "YOUR_CLIENT_SECRET",
      "pickupUnassigned": true,
      "autoClose": true,
      "escalationAssigneeId": "HUMAN_TEAMMATE_OR_TEAM_ID",
      "escalationAssigneeType": "admin",
      "createMissingTags": true,
      "contactContext": true
    }
  }
}
```

- `token`: Your Intercom Access Token (Permanent Token).
- `adminId`: The ID of the teammate the bot should act as. Auto-resolved via `/me` if omitted.
- `pollIntervalSeconds`: Polling frequency (default: 20).
- `inbound`: `poll`, `webhook`, or `both` (default: `poll`).
- `webhookSecret`: Your Intercom App Client Secret (Signing Secret).
- `pickupUnassigned`: Also answer and claim open conversations that arrive unassigned (default: `true`).
- `autoClose`: Close a conversation after replying on `[[close]]` or a customer resolution phrase (default: `true`).
- `escalationAssigneeId`: Teammate (admin) or team id the bot hands off to on `[[escalate]]`. If unset, escalation is logged and no-ops.
- `escalationAssigneeType`: Whether `escalationAssigneeId` is an `admin` (teammate) or a `team` (default: `admin`).
- `createMissingTags`: Create tags that don't exist yet when the agent emits `[[tag: ...]]` (default: `true`).
- `contactContext`: Fetch the customer's Intercom contact profile and give it to the agent as reply context (default: `true`).

### Allowed permissions
The access token needs read/write on Conversations and Contacts, plus Tags (list/create) if you use `[[tag: ...]]`.

## Webhooks Setup
1. Set `inbound` to `webhook` or `both`.
2. Configure your Intercom App Webhook URL to: `https://your-gateway-url/intercom/webhook`.
3. Subscribe to the following topics:
   - `conversation.user.created`
   - `conversation.user.replied`

## Standalone Repository
This package is initialized as its own git repository. To push to GitHub:
```bash
git remote add origin <your-repo-url>
git push -u origin main
```