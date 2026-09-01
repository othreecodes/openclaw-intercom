import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveIntercomAccount } from "./config.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

const manifestPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "openclaw.plugin.json",
);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const schema = manifest.channelConfigs.intercom.schema;

/**
 * The manifest schema sets additionalProperties: false, so the gateway refuses
 * to start if config.ts reads an option the schema does not declare. Keeping
 * these in step is easy to forget and fails only at runtime, so assert it.
 */
describe("channel config schema", () => {
  it("declares every option resolveIntercomAccount reads", () => {
    const declared = new Set(Object.keys(schema.properties));
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "config.ts"),
      "utf8",
    );
    const read = [...source.matchAll(/\bsection\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);

    const missing = [...new Set(read)].filter((key) => !declared.has(key));
    expect(missing).toEqual([]);
  });

  it("accepts a config using every declared property", () => {
    const cfg = {
      channels: {
        intercom: {
          enabled: true,
          token: "tok",
          adminId: "1",
          inbound: "poll",
          pollIntervalSeconds: 10,
          maxConcurrentConversations: 10,
        },
      },
    } as unknown as OpenClawConfig;

    const account = resolveIntercomAccount(cfg);

    expect(account.maxConcurrentConversations).toBe(10);
    expect(account.pollIntervalSeconds).toBe(10);
  });

  it("falls back to the documented default when the option is absent", () => {
    const cfg = { channels: { intercom: { token: "tok" } } } as unknown as OpenClawConfig;
    expect(resolveIntercomAccount(cfg).maxConcurrentConversations).toBe(
      schema.properties.maxConcurrentConversations.default,
    );
  });

  it("ignores an invalid concurrency value rather than breaking the poll loop", () => {
    for (const bad of [0, -5, Number.NaN, "ten"]) {
      const cfg = {
        channels: { intercom: { token: "tok", maxConcurrentConversations: bad } },
      } as unknown as OpenClawConfig;
      expect(resolveIntercomAccount(cfg).maxConcurrentConversations).toBe(10);
    }
  });
});
