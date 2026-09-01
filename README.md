# OpenClaw Intercom Plugin

This plugin allows an OpenClaw agent to act as a support teammate in Intercom.io.

## Features
- **Hybrid Inbound**: Polling, Webhooks, or Both.
- **Deduplication**: Unified path for poll/webhook messages using conversation part IDs.
- **Auto-Reply**: Responds to customers as admin comments.
- **Session Threading**: Maps Intercom conversations to OpenClaw sessions.

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
      "webhookSecret": "YOUR_CLIENT_SECRET"
    }
  }
}
```

- `token`: Your Intercom Access Token (Permanent Token).
- `adminId`: The ID of the teammate the bot should act as. Auto-resolved via `/me` if omitted.
- `pollIntervalSeconds`: Polling frequency (default: 20).
- `inbound`: `poll`, `webhook`, or `both` (default: `poll`).
- `webhookSecret`: Your Intercom App Client Secret (Signing Secret).

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