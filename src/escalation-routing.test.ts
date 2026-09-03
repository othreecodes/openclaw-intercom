import { describe, expect, it } from "vitest";

import { normalizeEscalationTargets } from "./config.js";
import { parseDirectives, resolveEscalationRoute } from "./inbox.js";
import type { ResolvedEscalationTarget } from "./types.js";

const targets = (): Record<string, ResolvedEscalationTarget> =>
  normalizeEscalationTargets({
    Payments: { id: "100", type: "team", description: "failed or missing payments" },
    fraud: { id: "200", type: "team" },
    founder: { id: "300", type: "admin" },
  });

describe("parseDirectives escalation routing", () => {
  it("captures the queue from [[escalate to x: reason]]", () => {
    const d = parseDirectives("Sorry!\n[[escalate to payments: withdrawal never landed]]");
    expect(d.escalate).toBe(true);
    expect(d.escalateTarget).toBe("payments");
    expect(d.escalateReason).toBe("withdrawal never landed");
    expect(d.text).toBe("Sorry!");
  });

  it("supports a queue with no reason", () => {
    const d = parseDirectives("[[escalate to fraud]]");
    expect(d.escalateTarget).toBe("fraud");
    expect(d.escalateReason).toBeUndefined();
  });

  it("keeps the unrouted form working", () => {
    const d = parseDirectives("[[escalate: cannot verify this account]]");
    expect(d.escalate).toBe(true);
    expect(d.escalateTarget).toBeUndefined();
    expect(d.escalateReason).toBe("cannot verify this account");
  });

  it("does not mistake a reason that mentions a team for a routing choice", () => {
    const d = parseDirectives("[[escalate: please pass this to the payments team]]");
    expect(d.escalateTarget).toBeUndefined();
    expect(d.escalateReason).toBe("please pass this to the payments team");
  });
});

describe("resolveEscalationRoute", () => {
  it("routes to the named queue, case-insensitively", () => {
    expect(resolveEscalationRoute("PAYMENTS", targets(), "999", "admin")).toEqual({
      id: "100",
      type: "team",
      name: "Payments",
    });
  });

  it("falls back to the default and reports a queue that does not exist", () => {
    expect(resolveEscalationRoute("compliance", targets(), "999", "admin")).toEqual({
      id: "999",
      type: "admin",
      unknownTarget: "compliance",
    });
  });

  it("uses the default when no queue is named", () => {
    expect(resolveEscalationRoute(undefined, targets(), "999", "team")).toEqual({
      id: "999",
      type: "team",
    });
  });

  it("returns nothing when there is no queue and no default", () => {
    expect(resolveEscalationRoute("payments", {}, undefined, "admin")).toBeUndefined();
    expect(resolveEscalationRoute(undefined, {}, undefined, "admin")).toBeUndefined();
  });

  it("honours an admin-typed route", () => {
    expect(resolveEscalationRoute("founder", targets(), "999", "team")?.type).toBe("admin");
  });
});

describe("normalizeEscalationTargets", () => {
  it("defaults a route to a team rather than an individual", () => {
    expect(normalizeEscalationTargets({ ops: { id: "1" } }).ops.type).toBe("team");
  });

  it("drops routes with no id so a typo cannot route conversations nowhere", () => {
    const out = normalizeEscalationTargets({
      good: { id: "1" },
      bad: { id: "  " } as never,
    });
    expect(Object.keys(out)).toEqual(["good"]);
  });

  it("preserves the configured spelling for logs while keying lowercase", () => {
    const out = normalizeEscalationTargets({ "Payments Ops": { id: "1" } });
    expect(out["payments ops"].name).toBe("Payments Ops");
  });

  it("returns an empty map when unset", () => {
    expect(normalizeEscalationTargets(undefined)).toEqual({});
  });
});
