import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../src/storage/memory-store.js";
import type { CompletedEntry, PendingEntry } from "../../src/types/index.js";

const pending = (reservationId: string, fingerprint = "fingerprint"): PendingEntry => ({
  state: "pending",
  fingerprint,
  reservationId,
  expiresAt: Date.now() + 1000
});

describe("MemoryStore", () => {
  const stores: MemoryStore[] = [];
  const createStore = (options: ConstructorParameters<typeof MemoryStore>[0] = {}) => {
    const store = new MemoryStore({ cleanupIntervalMs: 60_000, ...options });
    stores.push(store);
    return store;
  };

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    vi.useRealTimers();
  });

  it("atomically lets only one concurrent caller reserve a key", async () => {
    const store = createStore();
    const results = await Promise.all([
      store.reserve("key", pending("a"), 1000),
      store.reserve("key", pending("b"), 1000),
      store.reserve("key", pending("c"), 1000)
    ]);

    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    expect(results.filter((result) => !result.acquired)).toHaveLength(2);
  });

  it("allows completion and protects a newer reservation from stale writes", async () => {
    const store = createStore();
    await store.reserve("key", pending("owner-1"), 1000);
    const completed: CompletedEntry = {
      state: "complete",
      fingerprint: "fingerprint",
      reservationId: "owner-1",
      expiresAt: Date.now() + 1000,
      response: {
        statusCode: 201,
        headers: { "content-type": "application/json" },
        body: new Uint8Array([1, 2])
      }
    };

    expect(await store.set("key", completed, 1000, "wrong-owner")).toBe(false);
    expect(await store.set("key", completed, 1000, "owner-1")).toBe(true);
    const saved = await store.get("key");
    expect(saved).toMatchObject({ state: "complete", response: { statusCode: 201 } });
  });

  it("clones response objects returned from storage", async () => {
    const store = createStore();
    await store.reserve("key", pending("owner"), 1000);
    const completed: CompletedEntry = {
      state: "complete",
      fingerprint: "fingerprint",
      reservationId: "owner",
      expiresAt: Date.now() + 1000,
      response: {
        statusCode: 200,
        headers: { "content-type": "application/json", vary: ["accept"] },
        body: new Uint8Array([65])
      }
    };
    await store.set("key", completed, 1000, "owner");

    const returned = await store.get("key");
    if (!returned || returned.state !== "complete") throw new Error("Expected a completed entry.");
    returned.response.body[0] = 66;
    const returnedVary = returned.response.headers.vary;
    if (Array.isArray(returnedVary)) returnedVary.push("origin");

    const saved = await store.get("key");
    if (!saved || saved.state !== "complete") throw new Error("Expected a completed entry.");
    expect(saved.response.body[0]).toBe(65);
    expect(saved.response.headers.vary).toEqual(["accept"]);
  });

  it("expires records and prunes stale entries", async () => {
    vi.useFakeTimers();
    const store = createStore({ cleanupIntervalMs: 10 });
    await store.reserve("key", pending("owner"), 50);

    await vi.advanceTimersByTimeAsync(51);

    expect(await store.get("key")).toBeUndefined();
    expect(store.pruneExpired()).toBe(0);
    expect(store.size).toBe(0);
  });

  it("fails closed when its configured capacity is full", async () => {
    const store = createStore({ maxEntries: 1 });
    await store.reserve("first", pending("first"), 1000);

    await expect(store.reserve("second", pending("second"), 1000)).rejects.toThrow(/capacity/);
  });

  it("also enforces a total byte limit", async () => {
    const store = createStore({ maxBytes: 1 });
    await expect(store.reserve("key", pending("owner"), 1000)).rejects.toThrow(/capacity/);
    expect(store.size).toBe(0);
    expect(store.sizeInBytes).toBe(0);
  });
});
