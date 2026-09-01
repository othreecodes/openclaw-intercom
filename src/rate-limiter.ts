/**
 * Token bucket for outbound Intercom requests.
 *
 * The poll loop used to be serial, so it throttled itself. Now that several
 * conversations run at once, request rate scales with worker count and needs an
 * explicit ceiling: Intercom rate limits per app, and a 429 storm costs more
 * than pacing does.
 *
 * Capacity is the burst allowance; tokens refill continuously at
 * `capacity / intervalMs`. Waiters are served in arrival order so one busy
 * conversation cannot starve another.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly queue: Array<() => void> = [];
  private draining = false;

  constructor(
    private readonly capacity: number,
    private readonly intervalMs: number = 60_000,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
  ) {
    if (capacity <= 0) throw new Error("TokenBucket capacity must be > 0");
    this.tokens = capacity;
    this.lastRefill = now();
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    const gained = (elapsed / this.intervalMs) * this.capacity;
    if (gained <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + gained);
    this.lastRefill = now;
  }

  /** Milliseconds until at least one token is available. */
  private waitMs(): number {
    if (this.tokens >= 1) return 0;
    const deficit = 1 - this.tokens;
    return Math.ceil((deficit / this.capacity) * this.intervalMs);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        this.refill();
        const wait = this.waitMs();
        if (wait > 0) {
          await this.sleep(wait);
          continue;
        }
        this.tokens -= 1;
        this.queue.shift()?.();
      }
    } finally {
      this.draining = false;
    }
  }

  /** Resolves once a token is available, consuming it. */
  acquire(): Promise<void> {
    this.refill();
    // Fast path: a token is free and nobody is queued ahead of us.
    if (this.queue.length === 0 && this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      void this.drain();
    });
  }

  /** Tokens currently available. Exposed for diagnostics and tests. */
  get available(): number {
    this.refill();
    return this.tokens;
  }
}
