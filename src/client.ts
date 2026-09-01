import type { IntercomAdmin, IntercomContact, IntercomConversation, IntercomTag } from "./types.js";

import { TokenBucket } from "./rate-limiter.js";

const BASE_URL = "https://api.intercom.io";
const MAX_RETRY_AFTER_SECONDS = 60;
/** Requests per minute allowed by default. Conservative; tune per workspace plan. */
const DEFAULT_RATE_LIMIT_PER_MINUTE = 500;
/** Attempts for a retryable failure, including the first try. */
const DEFAULT_MAX_ATTEMPTS = 4;
/** Workspace tags change rarely; a short cache removes a fetch per tagged reply. */
const DEFAULT_TAG_CACHE_TTL_MS = 5 * 60_000;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
/** Transient server-side failures worth retrying. */
const RETRYABLE_STATUSES = new Set([408, 500, 502, 503, 504]);

export interface IntercomClientOptions {
  /** Outbound request ceiling per minute. Default 500. */
  rateLimitPerMinute?: number;
  /** Attempts for a retryable failure, including the first. Default 4. */
  maxAttempts?: number;
  /** How long the workspace tag list stays cached. Default 5 minutes. */
  tagCacheTtlMs?: number;
  /** Injectable sleep, for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter in [0,1), for tests. */
  random?: () => number;
}
/** Intercom's maximum page size for the search API. */
const SEARCH_PAGE_SIZE = 150;
/** Safety stop so one tick cannot page forever. 150 * 40 = 6000 conversations. */
const MAX_SEARCH_PAGES = 40;

export interface SearchOptions {
  perPage?: number;
  maxPages?: number;
}

interface IntercomSearchResponse {
  conversations?: IntercomConversation[];
  pages?: { next?: { starting_after?: string } | string };
}

export class IntercomApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    path: string,
  ) {
    super(`Intercom API error ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = "IntercomApiError";
  }
}

export class IntercomClient {
  private readonly limiter: TokenBucket;
  private readonly maxAttempts: number;
  private readonly tagCacheTtlMs: number;
  private tagCache: { tags: IntercomTag[]; expiresAt: number } | null = null;
  private tagFetch: Promise<IntercomTag[]> | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly token: string,
    private readonly apiVersion: string = "2.16",
    private readonly fetchImpl: typeof fetch = fetch,
    options: IntercomClientOptions = {},
  ) {
    this.limiter = new TokenBucket(options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.tagCacheTtlMs = options.tagCacheTtlMs ?? DEFAULT_TAG_CACHE_TTL_MS;
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, ms);
          timer.unref?.();
        }));
    this.random = options.random ?? Math.random;
  }

  /** Exponential backoff with full jitter, honouring Retry-After when given. */
  private backoffMs(attempt: number, retryAfterHeader: string | null): number {
    const retryAfter = Number(retryAfterHeader ?? "");
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return Math.min(retryAfter, MAX_RETRY_AFTER_SECONDS) * 1000;
    }
    const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
    // Full jitter: spreads a thundering herd of workers retrying together.
    return Math.floor(this.random() * ceiling);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      // Pace every attempt, retries included: a retry is another request.
      await this.limiter.acquire();

      let response: Response;
      try {
        response = await this.fetchImpl(`${BASE_URL}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Intercom-Version": this.apiVersion,
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        // Network-level failure (DNS, reset, timeout): retryable.
        lastError = err;
        if (attempt + 1 >= this.maxAttempts) break;
        await this.sleep(this.backoffMs(attempt, null));
        continue;
      }

      if (response.ok) return (await response.json()) as T;

      const retryable = response.status === 429 || RETRYABLE_STATUSES.has(response.status);
      if (!retryable || attempt + 1 >= this.maxAttempts) {
        throw new IntercomApiError(response.status, await response.text(), path);
      }

      lastError = new IntercomApiError(response.status, "", path);
      await this.sleep(this.backoffMs(attempt, response.headers.get("Retry-After")));
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Intercom request failed after ${this.maxAttempts} attempts on ${path}`);
  }

  me(): Promise<IntercomAdmin> {
    return this.request<IntercomAdmin>("GET", "/me");
  }

  /**
   * Page through /conversations/search until the results run out.
   *
   * Intercom returns a cursor in pages.next.starting_after. Without following
   * it we only ever saw the first page, so any backlog past one page was
   * invisible: results are sorted updated_at desc, so the customers waiting
   * longest are exactly the ones that fall off the end.
   *
   * maxPages is a safety stop so a pathological inbox cannot spin forever in
   * one tick; hitting it is logged by the caller through the returned count.
   */
  private async searchAll(
    value: unknown[],
    { perPage = SEARCH_PAGE_SIZE, maxPages = MAX_SEARCH_PAGES }: SearchOptions = {},
  ): Promise<IntercomConversation[]> {
    const all: IntercomConversation[] = [];
    let startingAfter: string | undefined;

    for (let page = 0; page < maxPages; page += 1) {
      const body: Record<string, unknown> = {
        query: { operator: "AND", value },
        sort_by: "updated_at",
        sort_order: "desc",
        pagination: startingAfter
          ? { per_page: perPage, starting_after: startingAfter }
          : { per_page: perPage },
      };
      const data = await this.request<IntercomSearchResponse>("POST", "/conversations/search", body);
      const batch = data.conversations ?? [];
      all.push(...batch);

      const next = data.pages?.next;
      // Intercom has returned next as both an object and a bare cursor string.
      startingAfter = typeof next === "string" ? next : next?.starting_after;
      if (!startingAfter || batch.length === 0) break;
    }
    return all;
  }

  searchAssignedConversations(
    adminId: string,
    options?: SearchOptions,
  ): Promise<IntercomConversation[]> {
    return this.searchAll(
      [
        { field: "admin_assignee_id", operator: "=", value: adminId },
        { field: "open", operator: "=", value: true },
      ],
      options,
    );
  }

  /** Open conversations that are not assigned to any admin (assignee id 0). */
  searchUnassignedConversations(options?: SearchOptions): Promise<IntercomConversation[]> {
    return this.searchAll(
      [
        { field: "admin_assignee_id", operator: "=", value: 0 },
        { field: "open", operator: "=", value: true },
      ],
      options,
    );
  }

  /** Assign a conversation to the bot admin so it owns follow-up. */
  assign(conversationId: string, adminId: string): Promise<IntercomConversation> {
    return this.assignTo(conversationId, adminId, adminId, "admin");
  }

  /** Assign/reassign a conversation to a teammate ("admin") or a "team". */
  assignTo(
    conversationId: string,
    adminId: string,
    assigneeId: string,
    assigneeType: "admin" | "team" = "admin",
  ): Promise<IntercomConversation> {
    return this.request<IntercomConversation>(
      "POST",
      `/conversations/${encodeURIComponent(conversationId)}/parts`,
      {
        message_type: "assignment",
        type: assigneeType,
        admin_id: adminId,
        assignee_id: assigneeId,
      },
    );
  }

  /** Add a private admin note (not visible to the customer). */
  note(conversationId: string, adminId: string, body: string): Promise<IntercomConversation> {
    return this.request<IntercomConversation>(
      "POST",
      `/conversations/${encodeURIComponent(conversationId)}/reply`,
      {
        message_type: "note",
        type: "admin",
        admin_id: adminId,
        body,
      },
    );
  }

  /** Fetch a contact's profile for reply context. */
  getContact(contactId: string): Promise<IntercomContact> {
    return this.request<IntercomContact>("GET", `/contacts/${encodeURIComponent(contactId)}`);
  }

  /** List all workspace tags (id + name). */
  async listTags(): Promise<IntercomTag[]> {
    const cached = this.tagCache;
    if (cached && Date.now() < cached.expiresAt) return cached.tags;

    // Coalesce: several workers replying at once should share one fetch.
    if (!this.tagFetch) {
      this.tagFetch = this.request<{ data?: IntercomTag[] }>("GET", "/tags")
        .then((data) => {
          const tags = data.data ?? [];
          this.tagCache = { tags, expiresAt: Date.now() + this.tagCacheTtlMs };
          return tags;
        })
        .finally(() => {
          this.tagFetch = null;
        });
    }
    return this.tagFetch;
  }

  /** Drop the cached tag list, e.g. after creating a tag. */
  invalidateTagCache(): void {
    this.tagCache = null;
  }

  /** Create a tag by name, returning it (Intercom is idempotent on name). */
  async createTag(name: string): Promise<IntercomTag> {
    const tag = await this.request<IntercomTag>("POST", "/tags", { name });
    // Keep the cache coherent rather than waiting for the ttl.
    if (this.tagCache && !this.tagCache.tags.some((t) => t.id === tag.id)) {
      this.tagCache.tags = [...this.tagCache.tags, tag];
    }
    return tag;
  }

  /** Attach a tag (by id) to a conversation, as the acting admin. */
  tagConversation(conversationId: string, tagId: string, adminId: string): Promise<IntercomTag> {
    return this.request<IntercomTag>(
      "POST",
      `/conversations/${encodeURIComponent(conversationId)}/tags`,
      { id: tagId, admin_id: adminId },
    );
  }

  /** Close a conversation as the bot admin. */
  close(conversationId: string, adminId: string): Promise<IntercomConversation> {
    return this.request<IntercomConversation>(
      "POST",
      `/conversations/${encodeURIComponent(conversationId)}/parts`,
      {
        message_type: "close",
        type: "admin",
        admin_id: adminId,
      },
    );
  }

  getConversation(id: string): Promise<IntercomConversation> {
    return this.request<IntercomConversation>("GET", `/conversations/${encodeURIComponent(id)}`);
  }

  reply(conversationId: string, adminId: string, body: string): Promise<IntercomConversation> {
    return this.request<IntercomConversation>(
      "POST",
      `/conversations/${encodeURIComponent(conversationId)}/reply`,
      {
        message_type: "comment",
        type: "admin",
        admin_id: adminId,
        body,
      },
    );
  }
}
