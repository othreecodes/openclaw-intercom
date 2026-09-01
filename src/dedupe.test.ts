import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IntercomDedupeStore } from "./dedupe.js";

let dir: string;
let stateFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "intercom-dedupe-"));
  stateFile = path.join(dir, "nested", "dedupe.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("IntercomDedupeStore", () => {
  it("marks a part once and reports it processed", () => {
    const store = new IntercomDedupeStore(stateFile);
    expect(store.markProcessed("c1", "p1")).toBe(true);
    expect(store.markProcessed("c1", "p1")).toBe(false);
    expect(store.isProcessed("c1", "p1")).toBe(true);
    expect(store.isProcessed("c1", "p2")).toBe(false);
  });

  it("persists a mark immediately, without waiting for compaction", () => {
    const a = new IntercomDedupeStore(stateFile);
    a.markProcessed("c1", "p1");
    // No close()/compact(): a crash here must still leave the mark durable.
    const b = new IntercomDedupeStore(stateFile);
    expect(b.isProcessed("c1", "p1")).toBe(true);
  });

  it("survives a torn final journal line", () => {
    const store = new IntercomDedupeStore(stateFile);
    store.markProcessed("c1", "p1");
    fs.appendFileSync(`${stateFile}.journal`, '["c1","p2"');
    const reopened = new IntercomDedupeStore(stateFile);
    expect(reopened.isProcessed("c1", "p1")).toBe(true);
    expect(reopened.isProcessed("c1", "p2")).toBe(false);
  });

  it("compacts the journal into the snapshot and keeps the data", () => {
    const store = new IntercomDedupeStore(stateFile, () => {}, { compactThreshold: 3 });
    store.markProcessed("c1", "p1");
    store.markProcessed("c1", "p2");
    store.markProcessed("c1", "p3");
    expect(fs.existsSync(stateFile)).toBe(true);
    expect(fs.existsSync(`${stateFile}.journal`)).toBe(false);
    const reopened = new IntercomDedupeStore(stateFile);
    for (const id of ["p1", "p2", "p3"]) expect(reopened.isProcessed("c1", id)).toBe(true);
  });

  it("evicts conversations older than the ttl on load", () => {
    const store = new IntercomDedupeStore(stateFile);
    store.markProcessed("old", "p1");
    store.close();
    const snapshot = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    snapshot.conversations.old.seen = Date.now() - 40 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(stateFile, JSON.stringify(snapshot));

    const reopened = new IntercomDedupeStore(stateFile);
    expect(reopened.isProcessed("old", "p1")).toBe(false);
    expect(reopened.size).toBe(0);
  });

  it("keeps conversations inside the ttl", () => {
    const store = new IntercomDedupeStore(stateFile);
    store.markProcessed("fresh", "p1");
    store.close();
    const reopened = new IntercomDedupeStore(stateFile);
    expect(reopened.isProcessed("fresh", "p1")).toBe(true);
    expect(reopened.size).toBe(1);
  });

  it("caps ids per conversation and forgets the oldest", () => {
    const store = new IntercomDedupeStore(stateFile);
    for (let i = 0; i < 250; i += 1) store.markProcessed("c1", `p${i}`);
    expect(store.isProcessed("c1", "p0")).toBe(false);
    expect(store.isProcessed("c1", "p249")).toBe(true);
  });

  it("reads the legacy v1 array format", () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ c1: ["p1", "p2"] }));
    const store = new IntercomDedupeStore(stateFile);
    expect(store.isProcessed("c1", "p1")).toBe(true);
    expect(store.isProcessed("c1", "p2")).toBe(true);
    expect(store.markProcessed("c1", "p1")).toBe(false);
  });
});
