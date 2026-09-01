import { describe, expect, it } from "vitest";
import { TokenBucket } from "./rate-limiter.js";

/** Deterministic clock + sleep so pacing can be asserted without real time. */
function fakeClock() {
  let now = 0;
  const sleep = async (ms: number) => {
    now += ms;
  };
  return { now: () => now, sleep, advance: (ms: number) => (now += ms) };
}

describe("TokenBucket", () => {
  it("allows a burst up to capacity without waiting", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(5, 60_000, clock.now, clock.sleep);
    for (let i = 0; i < 5; i += 1) await bucket.acquire();
    expect(clock.now()).toBe(0);
  });

  it("waits once the burst is spent", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 1_000, clock.now, clock.sleep);
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    expect(clock.now()).toBeGreaterThan(0);
  });

  it("refills over time", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(10, 1_000, clock.now, clock.sleep);
    for (let i = 0; i < 10; i += 1) await bucket.acquire();
    expect(bucket.available).toBeLessThan(1);
    clock.advance(500);
    expect(bucket.available).toBeCloseTo(5, 1);
  });

  it("never exceeds capacity when idle", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(3, 1_000, clock.now, clock.sleep);
    clock.advance(60_000);
    expect(bucket.available).toBe(3);
  });

  it("serves waiters in arrival order", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(1, 100, clock.now, clock.sleep);
    const order: number[] = [];
    await bucket.acquire();
    await Promise.all(
      [1, 2, 3].map(async (n) => {
        await bucket.acquire();
        order.push(n);
      }),
    );
    expect(order).toEqual([1, 2, 3]);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new TokenBucket(0)).toThrow();
  });
});
