import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EscalatedStore } from "./escalated.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "escalated-test-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("EscalatedStore", () => {
  it("is not escalated before being marked", () => {
    const s = new EscalatedStore(path.join(dir, "state.json"));
    expect(s.isEscalated("c1")).toBe(false);
  });

  it("is escalated immediately after marking, without a restart", () => {
    const s = new EscalatedStore(path.join(dir, "state.json"));
    s.markEscalated("c1");
    expect(s.isEscalated("c1")).toBe(true);
    expect(s.isEscalated("c2")).toBe(false);
  });

  it("survives a restart via the journal before any compaction", () => {
    const file = path.join(dir, "state.json");
    const a = new EscalatedStore(file);
    a.markEscalated("c1");
    const b = new EscalatedStore(file);
    expect(b.isEscalated("c1")).toBe(true);
  });

  it("survives a restart after compaction folds the journal into a snapshot", () => {
    const file = path.join(dir, "state.json");
    const a = new EscalatedStore(file, undefined, { compactThreshold: 2 });
    a.markEscalated("c1");
    a.markEscalated("c2"); // crosses compactThreshold -> snapshot written, journal cleared
    expect(fs.existsSync(`${file}.journal`)).toBe(false);
    const b = new EscalatedStore(file);
    expect(b.isEscalated("c1")).toBe(true);
    expect(b.isEscalated("c2")).toBe(true);
  });

  it("marking twice is idempotent", () => {
    const s = new EscalatedStore(path.join(dir, "state.json"));
    s.markEscalated("c1");
    s.markEscalated("c1");
    expect(s.size).toBe(1);
  });

  it("drops entries older than the TTL on load", () => {
    const file = path.join(dir, "state.json");
    fs.writeFileSync(file, JSON.stringify({ old: Date.now() - 1000 }));
    const s = new EscalatedStore(file, undefined, { ttlMs: 500 });
    expect(s.isEscalated("old")).toBe(false);
  });
});
