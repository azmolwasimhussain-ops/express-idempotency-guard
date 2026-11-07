import type { Response } from "express";
import type { CachedResponse } from "../types/index.js";

export interface ResponseCapture {
  supported: boolean;
  body: Uint8Array;
}

/**
 * Captures only one buffered `end` payload. Any `write` call marks a response
 * as streaming, so it is delivered normally but is not cached or replayed.
 */
export function captureBufferedResponse(res: Response, maxBytes: number): ResponseCapture {
  let supported = true;
  let body: Uint8Array = new Uint8Array();

  const originalWrite = res.write;
  res.write = ((...args: unknown[]) => {
    supported = false;
    return Reflect.apply(originalWrite, res, args);
  }) as typeof res.write;

  const originalEnd = res.end;
  res.end = ((...args: unknown[]) => {
    if (supported) {
      const chunk = toBytes(args[0], args[1], maxBytes);
      if (!chunk) supported = false;
      else body = chunk;
    }
    return Reflect.apply(originalEnd, res, args);
  }) as typeof res.end;

  return {
    get supported() {
      return supported;
    },
    get body() {
      return new Uint8Array(body);
    }
  };
}

export function snapshotResponse(
  res: Response,
  capture: ResponseCapture,
  responseHeaders: ReadonlySet<string>
): CachedResponse | undefined {
  if (!capture.supported || res.getHeader("content-encoding") !== undefined) return undefined;

  const headers: CachedResponse["headers"] = {};
  const rawHeaders = res.getHeaders();
  for (const [name, value] of Object.entries(rawHeaders)) {
    const normalizedName = name.toLowerCase();
    if (!responseHeaders.has(normalizedName) || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number") {
      headers[normalizedName] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      headers[normalizedName] = [...value];
    }
  }

  return {
    statusCode: res.statusCode,
    headers,
    body: capture.body
  };
}

function toBytes(chunk: unknown, encoding: unknown, maxBytes: number): Uint8Array | undefined {
  if (chunk === undefined || chunk === null) return new Uint8Array();
  if (typeof chunk === "string") {
    const validEncoding = typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8";
    if (Buffer.byteLength(chunk, validEncoding) > maxBytes) return undefined;
    return Buffer.from(chunk, validEncoding);
  }
  if (chunk instanceof Uint8Array) {
    if (chunk.byteLength > maxBytes) return undefined;
    return new Uint8Array(chunk);
  }
  return undefined;
}
