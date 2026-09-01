
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import { IntercomClient } from "./client.js";

export const intercomChannel = createChatChannelPlugin({
  id: "intercom",
  label: "Intercom",
  
  async resolveAccount(config) {
    const client = new IntercomClient(config.token, config.apiVersion);
    let adminId = config.adminId;
    if (!adminId) {
      const me = await client.me();
      adminId = me.id;
    }
    return {
      id: adminId,
      name: `Intercom Admin ${adminId}`,
      enabled: true
    };
  },

  async createMessagingAdapter(account, config) {
    const client = new IntercomClient(config.token, config.apiVersion);
    const adminId = account.id;

    return {
      async sendText(target, text) {
        await client.reply(target.conversationId, adminId, text);
        return { success: true };
      }
    };
  }
});
