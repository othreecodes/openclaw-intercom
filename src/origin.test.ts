import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OriginStore, originAsRoute } from "./origin.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "origin-test-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("OriginStore", () => {
  it("records a conversation's first-seen assignment", () => {
    const s = new OriginStore(path.join(dir, "state.json"));
    s.recordIfAbsent("c1", { teamId: "5550689" });
    expect(s.get("c1")).toEqual({ teamId: "5550689" });
  });

  it("is write-once: a later call cannot overwrite the true origin", () => {
    const s = new OriginStore(path.join(dir, "state.json"));
    s.recordIfAbsent("c1", { teamId: "5550689" }); // true origin: Socials
    s.recordIfAbsent("c1", { adminId: "5111943" }); // Sisi's own later claim
    expect(s.get("c1")).toEqual({ teamId: "5550689" });
  });

  it("records nothing for a conversation with no assignee at all", () => {
    const s = new OriginStore(path.join(dir, "state.json"));
    s.recordIfAbsent("c1", {});
    expect(s.get("c1")).toBeUndefined();
  });

  it("survives a restart via the journal", () => {
    const file = path.join(dir, "state.json");
    const a = new OriginStore(file);
    a.recordIfAbsent("c1", { teamId: "8407270" });
    const b = new OriginStore(file);
    expect(b.get("c1")).toEqual({ teamId: "8407270" });
  });

  it("survives a restart after compaction", () => {
    const file = path.join(dir, "state.json");
    const a = new OriginStore(file, undefined, { compactThreshold: 1 });
    a.recordIfAbsent("c1", { teamId: "8407270" });
    expect(fs.existsSync(`${file}.journal`)).toBe(false);
    const b = new OriginStore(file);
    expect(b.get("c1")).toEqual({ teamId: "8407270" });
  });
});

describe("originAsRoute", () => {
  it("prefers the team over an admin when both are somehow set", () => {
    expect(originAsRoute({ teamId: "T", adminId: "A" })).toEqual({ id: "T", type: "team" });
  });

  it("falls back to the admin when there is no team", () => {
    expect(originAsRoute({ adminId: "A" })).toEqual({ id: "A", type: "admin" });
  });

  it("is undefined when there is no recorded origin", () => {
    expect(originAsRoute(undefined)).toBeUndefined();
  });
});
