import { describe, expect, it } from "vitest";
import { validateKey } from "../../src/utils/validation.js";

describe("idempotency key validation", () => {
  it("accepts a key whose visible ASCII length is exactly at the configured limit", () => {
    expect(validateKey("a!~_", 4)).toBe("a!~_");
  });

  it.each(["has space", "non-ascii-é", "control-\u007f"])(
    "rejects keys containing non-visible-ASCII characters (%s)",
    (key) => {
      expect(() => validateKey(key, 32)).toThrow(/visible ASCII characters/);
    }
  );
});
