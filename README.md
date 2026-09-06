# Intercom Support Channel for OpenClaw

**An autonomous, customer-facing support agent inside your Intercom inbox.**

This is a *channel*, not an API helper. Most Intercom packages teach an agent to run the
Intercom API when *you* ask — list conversations, draft a reply, look up a contact. This
plugin is the other direction: **customers message any channel connected to your Intercom —
WhatsApp, Instagram, Facebook, in-app Messenger, SMS, email — and the agent answers them
directly** — greets them, resolves
what it can, tags and annotates as it goes, and hands anything it can't resolve to a human
teammate, then gets out of the way.

It runs a real support desk. It has the scars to prove it — every behavior below exists
because production demanded it.

## What it does

**Conversation handling**
- **Answers customers end to end** — one OpenClaw session per conversation, greeting on
  first contact, context carried across every turn.
- **Sees images.** Customer screenshots (standard uploads *and* Instagram's inline-image
  format) are downloaded and read through the runtime's image understanding, so "here's the
  error" gets an answer about what's actually on the screen.
- **Proper formatting.** Replies render as real HTML — numbered steps, bullets, bold —
  instead of raw Markdown characters in a customer's DM.
- **Message bursts become one reply.** A customer sending five rapid messages (or a backlog
  entering scope) gets a single coherent answer with full context, not five overlapping ones.

**Judgment and hand-off**
- **Inline agent actions**, stripped before the customer sees them: `[[close]]`,
  `[[escalate: reason]]`, `[[note: text]]`, `[[tag: label]]` (one directive per tag; names
  containing commas survive intact).
- **Escalation means escalation.** A handed-off conversation returns to the inbox it came
  from and the agent *never touches it again* — no re-replies, no re-claims, and turns
  already queued when the escalation fired are dropped, not delivered.
- **Respects your human team.** Messages a teammate has already answered are absorbed as
  handled, never re-litigated — the agent only answers what came after the human's last word.
  (Workflow bots don't count as teammates, so auto-responders can't mute it.)
- **Safe first run.** Pointed at an inbox with an existing backlog, it absorbs history
  instead of answering your entire open inbox at once.

**Operations**
- **Hybrid inbound** — polling, webhooks, or both, with crash-safe dedupe so no customer is
  ever double-answered. Webhook payloads are treated as notifications and the canonical
  conversation is fetched (payload bodies differ from the API's, e.g. flattened images).
- **Channel scoping** — the agent answers every connected surface by default;
  `allowedChannels: ["instagram"]` pilots it on one channel and leaves the rest to humans,
  without claiming conversations it won't answer. Widen the list as confidence grows.
- **Tag discipline** — resolves against your existing tag vocabulary; unknown names are
  logged, not silently invented (`createMissingTags: false`).
- **Concurrency + rate limiting** — a worker pool per conversation and a token bucket over
  every outbound Intercom call.
- **Dashboard-native config** — every option below renders as a form in the OpenClaw
  Control UI, driven by the plugin's config schema.

---

## Requirements

- **OpenClaw** installed and running (`openclaw --version`).
- **Node.js 20+** (only needed if you want to run the typecheck/tests).
- An **Intercom workspace** where you can create an app and a teammate for the bot.

## Setup

### 1. Get an Intercom access token

1. Go to the [Intercom Developer Hub](https://app.intercom.com/a/developer-signup) and open **Your apps → New app** (or pick an existing one). Make sure it's installed on the workspace the bot should answer in.
2. Under **Authentication**, copy the **Access token**. This is the value for `token`.
3. Under **Authentication → Permissions**, enable at minimum:
   - **Read** and **Write** conversations
   - **Read** contacts (only if you keep `contactContext` on)
   - **Read** and **Write** tags (only if you use `[[tag: ...]]` with `createMissingTags`)
4. Under **Basic information**, copy the **Client secret** — that's the `webhookSecret` used to verify webhook signatures. You only need it for webhook mode.

Decide which teammate the bot posts as. If you leave `adminId` unset, the plugin resolves it
automatically from `GET /me` (the app's own admin). To post as a specific teammate, grab their
ID from **Settings → Teammates**, or from `GET https://api.intercom.io/admins`:

```bash
curl -s https://api.intercom.io/admins \
  -H "Authorization: Bearer $INTERCOM_TOKEN" \
  -H "Intercom-Version: 2.16" | jq '.admins[] | {id, name, email}'
```

### 2. Install the plugin

Straight from git:

```bash
openclaw plugins install https://github.com/othreecodes/openclaw-intercom.git
```

Or from a local checkout — use `--link` if you plan to hack on it, so OpenClaw loads the
directory in place instead of copying it:

```bash
git clone https://github.com/othreecodes/openclaw-intercom.git
openclaw plugins install ./openclaw-intercom --link
```

Confirm it registered:

```bash
openclaw plugins list          # "intercom" is listed
openclaw plugins doctor        # reports any load errors
```

### 3. Configure the channel

Add an `intercom` section to `channels` in your config file (`~/.openclaw/openclaw.json` —
`openclaw config file` prints the exact path):

```json
{
  "channels": {
    "intercom": {
      "enabled": true,
      "token": "YOUR_ACCESS_TOKEN",
      "inbound": "poll",
      "pollIntervalSeconds": 20
    }
  }
}
```

That's the minimum — `token` is the only required field. Everything else has a working default.

You can also set it from the CLI instead of editing the file by hand:

```bash
openclaw config set channels.intercom.token "YOUR_ACCESS_TOKEN"
openclaw config set channels.intercom.inbound poll
```

A fuller example with every option set:

```json
{
  "channels": {
    "intercom": {
      "enabled": true,
      "token": "YOUR_ACCESS_TOKEN",
      "adminId": "OPTIONAL_ADMIN_ID",
      "inbound": "both",
      "pollIntervalSeconds": 20,
      "webhookSecret": "YOUR_CLIENT_SECRET",
      "apiVersion": "2.16",
      "allowFrom": ["CONTACT_ID_1", "CONTACT_ID_2"],
      "pickupUnassigned": true,
      "autoClose": true,
      "escalationAssigneeId": "HUMAN_TEAMMATE_OR_TEAM_ID",
      "escalationAssigneeType": "admin",
      "createMissingTags": true,
      "contactContext": true,
      "persona": "You are Ocean from Cowrywise Support — warm, direct, and professional.",
      "maxConcurrentConversations": 10,
      "rateLimitPerMinute": 500
    }
  }
}
```

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `token` | string | *(required)* | Intercom access token. |
| `enabled` | boolean | `true` | Set to `false` to keep the config but stop the channel. |
| `adminId` | string | auto | Teammate the bot acts as. Auto-resolved via `GET /me` when omitted. |
| `inbound` | `poll` \| `webhook` \| `both` | `poll` | How messages arrive. |
| `pollIntervalSeconds` | number | `20` | Polling frequency, in seconds. |
| `webhookSecret` | string | — | App client secret, used to verify the `X-Hub-Signature` header. |
| `apiVersion` | string | `2.16` | Value of the `Intercom-Version` request header. |
| `allowFrom` | string[] | — | Allowlist of Intercom contact IDs. Everyone is allowed when unset. |
| `pickupUnassigned` | boolean | `true` | Also answer and claim open conversations that arrive unassigned. |
| `autoClose` | boolean | `true` | Close after replying on `[[close]]` or a customer resolution phrase. |
| `escalationAssigneeId` | string | — | Fallback hand-off target on `[[escalate]]` when the conversation has no recorded origin inbox. Escalation prefers the team/teammate the conversation was on before the bot touched it. |
| `escalationAssigneeType` | `admin` \| `team` | `admin` | Whether `escalationAssigneeId` is a teammate or a team. |
| `escalationTargets` | object | — | Named hand-off queues (`{name: {id, type, description}}`) used as the fallback router when no origin inbox is known. |
| `allowedChannels` | string[] | — | Intercom surfaces to answer, e.g. `["instagram"]`. Unset answers every channel; others are left untouched and never claimed. |
| `createMissingTags` | boolean | `true` | Create tags that don't exist yet when the agent emits `[[tag: ...]]`. Set `false` to enforce your existing vocabulary. |
| `contactContext` | boolean | `true` | Fetch the customer's contact profile and give it to the agent as reply context. |
| `persona` | string | neutral support voice | Voice/identity the agent adopts when replying to customers. See [Support persona](#support-persona). |
| `maxConcurrentConversations` | number | `10` | How many conversations the agent works on at once. Each one is finished before that worker starts another. See [Throughput](#throughput). |
| `rateLimitPerMinute` | number | `500` | Ceiling on outbound Intercom API requests per minute. See [Throughput](#throughput). |
| `replyToExistingOnStart` | boolean | `false` | Answer conversations that already existed the first time the channel ran. See [First run](#first-run). |

#### First run

The first time the channel starts, it has no record of what it has already seen. Every
message in every open conversation therefore looks new. Left unchecked the bot answers your
entire open inbox at once, which is exactly as bad as it sounds.

So on a first run the plugin **absorbs** the existing inbox instead: it records every message
already there as handled and replies to none of it, then logs

```
intercom: first run, absorbed 12 existing conversation(s) (35 message(s)) without replying
```

From the next message onward it behaves normally.

This applies only to a genuine first run, detected by an empty dedupe store. Later restarts
read the persisted state, so a message that arrived while the gateway was down is still
answered — the backlog is skipped once, not on every restart.

Set `replyToExistingOnStart: true` if you actually do want the existing inbox answered.

`inbound: "webhook"` sidesteps this entirely, since webhooks only deliver events that happen
after the subscription exists.

#### Throughput

`maxConcurrentConversations` (default `10`) caps how many conversations the agent
works on at the same time.

Within a conversation nothing is parallel: the agent replies, adds any notes,
applies tags, and then closes or escalates before that worker picks up the next
conversation. So a conversation is always finished rather than left half-answered,
and its parts are handled in order. Raising the limit adds more conversations
side by side; it never splits one conversation across workers.

A poll tick and a webhook delivery for the same conversation cannot run at once
either — whichever arrives second is skipped and picked up on the next pass.

Two things to size against:

- Your model's throughput and cost. Each conversation in flight is a live agent
  turn.
- `agents.defaults.maxConcurrent` in your OpenClaw config, which caps concurrent
  agent runs gateway-wide. If it is lower than this setting, it is the real limit.

##### Staying inside Intercom's rate limit

`rateLimitPerMinute` (default `500`) is a token bucket over every outbound call,
retries included. Concurrency multiplies request rate, so this is the ceiling
that keeps that from turning into a wall of 429s. Check the limit on your
Intercom plan and set it below that.

Requests are retried up to 4 times on `429`, `408` and 5xx, and on network
failures, using exponential backoff with full jitter. A `Retry-After` header is
honoured when Intercom sends one. Other 4xx responses fail immediately.

The plugin also avoids work it does not need to do:

- A conversation is only fetched in full when the `updated_at` returned by
  search has moved since it was last ingested. At a short poll interval this is
  the largest single saving.
- The workspace tag list is cached for 5 minutes and concurrent callers share
  one fetch, instead of listing tags on every tagged reply.

Both are transparent: nothing is skipped that could contain a new message.

#### Support persona

By default the agent replies in a neutral, professional support voice — even if your
OpenClaw agent normally has a strong personality, the plugin frames each ticket as a
generic support agent so customers get a clean, on-brand reply.

Set `persona` to give it a specific voice or identity. The string is injected verbatim into
the per-message instructions, so write it as a direct instruction to the agent:

```json
{ "channels": { "intercom": { "persona": "You are Ocean from Cowrywise Support — warm, direct, and genuinely helpful. Keep it professional and concise; never crude or overly casual." } } }
```

Regardless of `persona`, the plugin always pins the customer's real identity (so the agent
never mistakes the customer for you) and appends the available inline actions — you're only
customizing the voice, not the guardrails.

### 4. Set up webhooks (only for `inbound: "webhook"` or `"both"`)

Polling needs nothing else — skip this section if you're using `inbound: "poll"`.

1. Make sure your OpenClaw gateway is reachable over HTTPS. For local testing, tunnel its HTTP
   port (`openclaw config get gateway.port` shows which one it's on):
   ```bash
   ngrok http <gateway-port>
   ```
2. In the Developer Hub, open **Webhooks** and set the endpoint to:
   ```
   https://your-gateway-url/intercom/webhook
   ```
3. Subscribe to these topics:
   - `conversation.user.created`
   - `conversation.user.replied`
4. Set `webhookSecret` in `openclaw.json` to the app's **Client secret**. Requests whose
   `X-Hub-Signature` doesn't verify are rejected.

### 5. Start it and send a test message

Restart the gateway so it picks up the new plugin and config:

```bash
openclaw gateway run --force
```

Then check the channel came up, message your workspace from the Messenger (or reply to a
conversation assigned to the bot admin), and watch the logs:

```bash
openclaw channels status --probe      # intercom: enabled + configured, with inbound mode and adminId
openclaw channels logs                # ingest + reply activity
```

`configured` stays `false` until `channels.intercom.token` is set.

## Development

```bash
npm install
npm run typecheck
npm test
```

Both the typecheck and the tests resolve the OpenClaw plugin SDK from a **globally installed
openclaw**, at the hardcoded path `/opt/homebrew/lib/node_modules/openclaw/dist`
(`tsconfig.json` `paths`, and the alias in `vitest.config.ts`). That path is correct for Homebrew
on Apple Silicon. Elsewhere, find yours with:

```bash
echo "$(npm root -g)/openclaw/dist"
```

and update both files to match.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `intercom: set channels.intercom.token` | `token` is missing or empty in `openclaw.json`. |
| `intercom: could not resolve adminId from GET /me` | The token is invalid, or the app isn't installed on the workspace. Set `adminId` explicitly to rule it out. |
| Nothing gets answered | Conversations are unassigned and `pickupUnassigned` is `false`, or they aren't assigned to the resolved `adminId`. |
| Webhook events ignored | `inbound` isn't `webhook`/`both`, or the signature failed — check that `webhookSecret` is the app's **Client secret**. |
| Sender skipped in the logs | The contact isn't in `allowFrom`. |
| Tags don't appear | Token lacks tag write scope, or `createMissingTags` is `false` and the tag doesn't exist. |
| Typecheck/test failures about `openclaw/plugin-sdk/*` | The global openclaw SDK path doesn't match the one in `tsconfig.json` / `vitest.config.ts` — see [Development](#development). |

## License

MIT — see [LICENSE](LICENSE).
