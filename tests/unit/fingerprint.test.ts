import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { canonicalize, createRequestFingerprint } from "../../src/core/fingerprint.js";

function request(overrides: Partial<Request> = {}): Request {
  return {
    method: "POST",
    path: "/payments",
    originalUrl: "/payments?currency=usd",
    baseUrl: "",
    route: { path: "/payments" },
    body: { amount: 20, currency: "usd" },
    headers: {},
    ...overrides
  } as Request;
}

describe("request fingerprints", () => {
  it("canonicalizes object properties without changing array order", () => {
    expect(canonicalize({ z: 1, a: { y: 2, x: 3 }, list: [2, 1] })).toBe(
      '{"a":{"x":3,"y":2},"list":[2,1],"z":1}'
    );
    expect(canonicalize(["first", "second"])).not.toBe(canonicalize(["second", "first"]));
  });

  it("normalizes dates, byte arrays, non-finite numbers, and undefined object values", () => {
    const value = {
      bytes: new Uint8Array([0, 255]),
      date: new Date("2026-11-07T12:00:00.000Z"),
      omitted: undefined,
      values: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
    };

    expect(canonicalize(value)).toBe(
      '{"bytes":{"$bytes":"AP8="},"date":"2026-11-07T12:00:00.000Z","values":[null,null,null]}'
    );
  });

  it("matches retries whose JSON object keys are in a different order", async () => {
    const one = await createRequestFingerprint(request(), { maxBytes: 1024 });
    const two = await createRequestFingerprint(
      request({ body: { currency: "usd", amount: 20 } } as Partial<Request>),
      { maxBytes: 1024 }
    );
    expect(two).toBe(one);
  });

  it("includes method, route, URL, and payload in the digest", async () => {
    const baseline = await createRequestFingerprint(request(), { maxBytes: 1024 });
    const changedMethod = await createRequestFingerprint(request({ method: "PATCH" }), {
      maxBytes: 1024
    });
    const changedUrl = await createRequestFingerprint(request({ originalUrl: "/other" }), {
      maxBytes: 1024
    });
    const changedBody = await createRequestFingerprint(request({ body: { amount: 21 } }), {
      maxBytes: 1024
    });

    expect(new Set([baseline, changedMethod, changedUrl, changedBody]).size).toBe(4);
  });

  it("rejects an unparsed non-empty request body", async () => {
    await expect(
      createRequestFingerprint(request({ body: undefined, headers: { "content-length": "8" } }), {
        maxBytes: 1024
      })
    ).rejects.toMatchObject({ code: "BODY_NOT_PARSED", statusCode: 400 });
  });

  it("supports requests with no body", async () => {
    await expect(
      createRequestFingerprint(request({ body: undefined }), { maxBytes: 1024 })
    ).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects fingerprints that exceed the configured size", async () => {
    await expect(createRequestFingerprint(request(), { maxBytes: 4 })).rejects.toMatchObject({
      code: "FINGERPRINT_TOO_LARGE",
      statusCode: 413
    });
  });
});
