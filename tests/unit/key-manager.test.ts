import { describe, expect, it } from "vitest";
import { createStorageKey } from "../../src/core/key-manager.js";

describe("createStorageKey", () => {
  it("does not expose the caller key and separates trusted scopes", () => {
    const first = createStorageKey("tenant-a", "client-key");
    expect(first).not.toContain("client-key");
    expect(createStorageKey("tenant-a", "client-key")).toBe(first);
    expect(createStorageKey("tenant-b", "client-key")).not.toBe(first);
  });
});
