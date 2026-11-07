import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { captureBufferedResponse } from "../../src/core/response-capture.js";

function responseStub(): Response {
  const response = {
    write: () => true,
    end: () => response
  } as unknown as Response;
  return response;
}

describe("buffered response capture", () => {
  it("rejects oversized byte arrays without copying them", () => {
    const response = responseStub();
    const capture = captureBufferedResponse(response, 1);
    const chunk = new Uint8Array(8 * 1024 * 1024);
    const bytesBeforeEnd = process.memoryUsage().arrayBuffers;

    response.end(chunk);

    const allocatedBytes = process.memoryUsage().arrayBuffers - bytesBeforeEnd;
    expect(capture.supported).toBe(false);
    expect(allocatedBytes).toBeLessThan(chunk.byteLength / 2);
  });

  it("checks UTF-8 byte length before encoding oversized strings", () => {
    const response = responseStub();
    const capture = captureBufferedResponse(response, 4);
    const bufferFrom = vi.spyOn(Buffer, "from");

    response.end("💳💳");

    const copyCalls = bufferFrom.mock.calls.length;
    bufferFrom.mockRestore();
    expect(capture.supported).toBe(false);
    expect(copyCalls).toBe(0);
  });
});
