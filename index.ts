
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { intercomChannel } from "./src/channel.js";
import { IntercomPoller } from "./src/poller.js";
import { IntercomClient } from "./src/client.js";
import { handleIntercomWebhook } from "./src/webhook.js";

const intercomEntry = defineChannelPluginEntry({
  id: "intercom",
  name: "Intercom",
  description: "Intercom support channel plugin (Polling + Webhook)",
  
  plugin: intercomChannel,

  async registerFull(api) {
    const config = api.getConfig("intercom") as any;
    if (!config || !config.token) return;

    const client = new IntercomClient(config.token, config.apiVersion);
    let adminId = config.adminId;
    if (!adminId) {
      try {
        const me = await client.me();
        adminId = me.id;
      } catch (e) {
        api.logger.error("Failed to auto-resolve Intercom adminId", { error: e });
        return;
      }
    }

    const stateDir = api.runtime.resolveStateDir("intercom");
    const poller = new IntercomPoller(
      client,
      adminId,
      config.pollIntervalSeconds || 20,
      api,
      stateDir
    );

    const dispatchInbound = async (conversationId: string, body: string, authorId: string, partId: string) => {
      if (poller.isProcessed(conversationId, partId)) return;
      
      poller.markProcessed(conversationId, partId);
      
      await api.channels.dispatchInbound("intercom", adminId, {
        conversationId,
        externalId: conversationId,
        text: body,
        sender: {
          id: authorId,
          name: "Customer"
        }
      });
    };

    const mode = config.inbound || "poll";

    if (mode === "poll" || mode === "both") {
      poller.start(dispatchInbound);
    }

    if (mode === "webhook" || mode === "both") {
      if (!config.webhookSecret) {
        api.logger.error("Intercom inbound mode includes webhook, but webhookSecret is missing");
      } else {
        api.registerHttpRoute("POST", "/intercom/webhook", handleIntercomWebhook(api, config.webhookSecret, dispatchInbound));
      }
    }

    api.runtime.onShutdown(() => {
      poller.stop();
    });
  }
});

export default intercomEntry;
