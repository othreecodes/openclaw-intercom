import { describe, expect, it } from "vitest";

describe("plugin entry", () => {
  it("loads the full entry module graph against the real SDK", async () => {
    const entry = (await import("../index.js")).default;
    expect(entry.id).toBe("intercom");
    expect(entry.channelPlugin).toBeDefined();
    expect(entry.channelPlugin.id).toBe("intercom");
    expect(typeof entry.register).toBe("function");
  });

  it("loads the setup entry with the channel plugin", async () => {
    const setup = (await import("../setup-entry.js")).default;
    expect(setup.plugin.id).toBe("intercom");
  });
});
