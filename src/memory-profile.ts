/**
 * Give Honcho peers a human name.
 *
 * Peer ids stay opaque and stable (`intercom-<contactId>`) -- see
 * memory-metadata.ts. What a person reads in the dashboard comes from peer
 * metadata instead, and nothing else writes it: the Honcho plugin only ever
 * sets `channelPeerId` and `autoSeeded`.
 *
 * Two API facts shape this file, both measured against the live server:
 *   - `POST /peers` on an existing peer REPLACES its metadata. The plugin
 *     calls it when it first sees a contact, which lands after our write and
 *     would wipe the name. So we write again on a delay, after that create.
 *   - `PUT /peers/{id}` also replaces, and returns 200 for a peer that does
 *     not exist yet. So every write reads the current metadata and merges.
 *
 * Nothing here is allowed to affect a reply: every call is fire-and-forget,
 * time-limited, and swallows its errors.
 */

export type MemoryProfileConfig = {
  baseUrl: string;
  apiKey: string;
  workspace: string;
};

export type MemoryProfile = {
  name?: string;
  email?: string;
  channel?: string;
  /** WhatsApp leads carry no email and a self-chosen display name, so the
   *  phone is frequently the only identifier that is actually theirs. */
  phone?: string;
};

/**
 * Read the Honcho plugin own config rather than duplicating baseUrl and key
 * in the intercom section -- two copies of a token drift.
 */
export function resolveMemoryProfileConfig(cfg: unknown): MemoryProfileConfig | undefined {
  const entry = (cfg as Record<string, any> | undefined)?.plugins?.entries?.["openclaw-honcho"];
  if (!entry || entry.enabled === false) return undefined;
  const c = entry.config;
  const baseUrl = typeof c?.baseUrl === "string" ? c.baseUrl.replace(/\/+$/, "") : "";
  const apiKey = typeof c?.apiKey === "string" ? c.apiKey : "";
  const workspace = typeof c?.workspaceId === "string" ? c.workspaceId : "";
  if (!baseUrl || !apiKey || !workspace) return undefined;
  return { baseUrl, apiKey, workspace };
}

export function memoryPeerId(contactId: string): string {
  return `intercom-${contactId}`;
}

/**
 * Intercom hands back names HTML-escaped -- a real contact comes through as
 * "Akin&#39;s Alaba Ayo". Stored raw, that is what the console shows and what
 * an agent would greet the customer with. Decode the handful of entities the
 * API actually emits; anything else is left alone rather than guessed at.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = Number(code);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const n = Number.parseInt(hex, 16);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : _;
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // Ampersand last: decoding it first would let "&amp;lt;" become "<".
    .replace(/&amp;/g, "&");
}

/** Trim and decode in one step -- every value we publish goes through here. */
function clean(value: string | undefined): string {
  return value ? decodeEntities(value.trim()).trim() : "";
}

/** Nothing worth showing: do not spend a request on it. */
function isEmpty(profile: MemoryProfile): boolean {
  return !clean(profile.name) && !clean(profile.email) && !clean(profile.phone);
}

export type MemoryProfileWriter = {
  /** Fire-and-forget. Safe to call on every inbound message. */
  record(contactId: string, profile: MemoryProfile): void;
  /** Await in-flight work. Tests and shutdown only. */
  drain(): Promise<void>;
  stop(): void;
};

export function createMemoryProfileWriter(params: {
  config: MemoryProfileConfig;
  fetchImpl?: typeof fetch;
  logger?: { warn: (message: string) => void };
  timeoutMs?: number;
  /** Delay before the follow-up write that outlives the plugin peer-create. */
  recreateDelayMs?: number;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
}): MemoryProfileWriter {
  const {
    config,
    fetchImpl = fetch,
    logger,
    timeoutMs = 5000,
    recreateDelayMs = 45_000,
    setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutImpl = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = params;

  const base = `${config.baseUrl}/v3/workspaces/${encodeURIComponent(config.workspace)}`;
  const headers = {
    authorization: `Bearer ${config.apiKey}`,
    "content-type": "application/json",
  };
  const inFlight = new Set<Promise<void>>();
  const pendingFollowUp = new Map<string, unknown>();
  let stopped = false;

  async function request(path: string, init: RequestInit): Promise<Response | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(`${base}${path}`, { ...init, headers, signal: controller.signal });
    } catch (err) {
      logger?.warn(`intercom: honcho profile request failed (${path}): ${String(err)}`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async function currentMetadata(peerId: string): Promise<Record<string, unknown>> {
    const res = await request(`/peers/list?size=1`, {
      method: "POST",
      body: JSON.stringify({ filters: { id: peerId } }),
    });
    if (!res?.ok) return {};
    try {
      const body = (await res.json()) as { items?: Array<{ metadata?: Record<string, unknown> }> };
      return body.items?.[0]?.metadata ?? {};
    } catch {
      return {};
    }
  }

  async function write(contactId: string, profile: MemoryProfile): Promise<void> {
    const peerId = memoryPeerId(contactId);
    const existing = await currentMetadata(peerId);
    // Merge: the plugin keys (channelPeerId, autoSeeded) are not ours to drop,
    // and a PUT replaces the whole object.
    const metadata: Record<string, unknown> = { ...existing, contactId, source: "intercom" };
    const name = clean(profile.name);
    const email = clean(profile.email);
    const channel = clean(profile.channel);
    const phone = clean(profile.phone);
    if (name) metadata.name = name;
    if (email) metadata.email = email;
    if (channel) metadata.channel = channel;
    if (phone) metadata.phone = phone;
    await request(`/peers/${encodeURIComponent(peerId)}`, {
      method: "PUT",
      body: JSON.stringify({ metadata }),
    });
  }

  function track(work: Promise<void>): void {
    const wrapped = work.catch(() => undefined);
    inFlight.add(wrapped);
    void wrapped.finally(() => inFlight.delete(wrapped));
  }

  return {
    record(contactId, profile) {
      if (stopped || !contactId || isEmpty(profile)) return;
      track(write(contactId, profile));
      // The plugin creates the peer at the end of the agent turn and replaces
      // metadata when it does. One delayed rewrite puts the name back; it is
      // debounced per contact so a busy conversation still causes just one.
      const existingTimer = pendingFollowUp.get(contactId);
      if (existingTimer !== undefined) clearTimeoutImpl(existingTimer);
      const timer = setTimeoutImpl(() => {
        pendingFollowUp.delete(contactId);
        if (!stopped) track(write(contactId, profile));
      }, recreateDelayMs);
      pendingFollowUp.set(contactId, timer);
      if (typeof (timer as { unref?: () => void })?.unref === "function") {
        (timer as { unref: () => void }).unref();
      }
    },
    async drain() {
      await Promise.allSettled([...inFlight]);
    },
    stop() {
      stopped = true;
      for (const timer of pendingFollowUp.values()) clearTimeoutImpl(timer);
      pendingFollowUp.clear();
    },
  };
}
