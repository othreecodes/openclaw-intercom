
import { describe, it, expect, vi, beforeEach } from "vitest";
import { IntercomClient } from "./client.js";
import { verifyIntercomSignature } from "./webhook.js";
import crypto from "node:crypto";

describe("IntercomClient", () => {
  let client: IntercomClient;
  const mockFetch = vi.fn();

  beforeEach(() => {
    global.fetch = mockFetch;
    client = new IntercomClient("test-token");
    mockFetch.mockReset();
  });

  it("calls /me to get admin info", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "admin-123", email: "bot@example.com" })
    });

    const me = await client.me();
    expect(me.id).toBe("admin-123");
    expect(mockFetch).toHaveBeenCalledWith("https://api.intercom.io/me", expect.any(Object));
  });
});

describe("Webhook Signature", () => {
  it("verifies valid signatures", () => {
    const secret = "secret";
    const body = '{"test":true}';
    const hmac = crypto.createHmac("sha1", secret).update(body).digest("hex");
    const signature = `sha1=${hmac}`;
    
    expect(verifyIntercomSignature(body, secret, signature)).toBe(true);
  });

  it("rejects invalid signatures", () => {
    expect(verifyIntercomSignature("body", "secret", "sha1=wrong")).toBe(false);
  });
});
