import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { GuardError, StoreCapacityError, toGuardError } from "../core/errors.js";
import { createRequestFingerprint } from "../core/fingerprint.js";
import { createStorageKey } from "../core/key-manager.js";
import { captureBufferedResponse, snapshotResponse } from "../core/response-capture.js";
import { MemoryStore } from "../storage/memory-store.js";
import type {
  CompletedEntry,
  IdempotencyGuardOptions,
  IdempotencyStore,
  PendingEntry,
  StoreEntry
} from "../types/index.js";
import {
  isSkipped,
  validateHeaderName,
  validateKey,
  validateOptions,
  validateScope
} from "../utils/validation.js";

const DEFAULT_TTL = 24 * 60 * 60 * 1000;
const DEFAULT_METHODS = ["POST", "PATCH"] as const;
const DEFAULT_RESPONSE_HEADERS = [
  "content-type",
  "etag",
  "location",
  "cache-control",
  "expires",
  "last-modified"
] as const;
const DEFAULT_STATUS_CODES = Array.from({ length: 100 }, (_, index) => 200 + index);

/** Create an Express middleware that protects configured methods with idempotency keys. */
export function idempotencyGuard(options: IdempotencyGuardOptions = {}) {
  const ttl = options.ttl ?? DEFAULT_TTL;
  const headerName = options.headerName ?? "Idempotency-Key";
  const methods = (options.methods ?? DEFAULT_METHODS).map((method) => method.toUpperCase());
  const maxKeyLength = options.maxKeyLength ?? 255;
  const maxFingerprintBytes = options.maxFingerprintBytes ?? 1024 * 1024;
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  const statusCodesToCache = options.statusCodesToCache ?? DEFAULT_STATUS_CODES;
  const inProgressStatusCode = options.inProgressStatusCode ?? 409;
  const inProgressWaitMs = options.inProgressWaitMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const requireKey = options.requireKey ?? true;
  const responseHeaders = (options.responseHeaders ?? DEFAULT_RESPONSE_HEADERS).map((name) =>
    name.toLowerCase()
  );
  const storage: IdempotencyStore = options.storage ?? new MemoryStore();

  validateHeaderName(headerName);
  validateOptions({
    ttl,
    methods,
    maxKeyLength,
    maxFingerprintBytes,
    maxResponseBytes,
    statusCodesToCache,
    inProgressStatusCode,
    inProgressWaitMs,
    pollIntervalMs,
    responseHeaders
  });

  const replayHeaders = new Set(responseHeaders);
  const cachedStatuses = new Set(statusCodesToCache);

  return function guard(req: Request, res: Response, next: NextFunction): void {
    if (!methods.includes(req.method.toUpperCase())) {
      next();
      return;
    }

    void runRequest(req, res, next).catch((error: unknown) => {
      handleRequestError(toGuardError(error), req, res, next, options.onError);
    });
  };

  async function runRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (isSkipped(req, options.skip)) {
      next();
      return;
    }

    const rawKey = req.get(headerName);
    if (!requireKey && rawKey === undefined) {
      next();
      return;
    }

    const key = validateKey(rawKey, maxKeyLength, headerName);
    const fingerprint = await createRequestFingerprint(req, {
      ...(options.fingerprint === undefined ? {} : { customFingerprint: options.fingerprint }),
      maxBytes: maxFingerprintBytes
    });
    const scope = validateScope(options.keyScope?.(req) ?? "");
    // Hash keys at rest so custom stores do not need to retain caller key text.
    const storageKey = createStorageKey(scope, key);
    const waitDeadline = Date.now() + inProgressWaitMs;

    while (!res.destroyed) {
      const reservationId = randomUUID();
      const pending: PendingEntry = {
        state: "pending",
        fingerprint,
        reservationId,
        expiresAt: Date.now() + ttl
      };
      const result = await storeCall(() => storage.reserve(storageKey, pending, ttl));

      if (result.acquired) {
        startOperation(req, res, next, storageKey, fingerprint, reservationId);
        return;
      }

      assertSameFingerprint(result.entry, fingerprint);
      if (result.entry.state === "complete") {
        replayResponse(res, result.entry);
        return;
      }

      const remaining = waitDeadline - Date.now();
      if (remaining <= 0) {
        throw new GuardError(
          "REQUEST_IN_PROGRESS",
          "A request with this idempotency key is still in progress. Retry shortly.",
          inProgressStatusCode
        );
      }

      await delay(Math.min(pollIntervalMs, remaining, 2_147_483_647));
      const current = await storeCall(() => storage.get(storageKey));
      if (!current) continue;
      assertSameFingerprint(current, fingerprint);
      if (current.state === "complete") {
        replayResponse(res, current);
        return;
      }
    }
  }

  function startOperation(
    req: Request,
    res: Response,
    next: NextFunction,
    storageKey: string,
    fingerprint: string,
    reservationId: string
  ): void {
    res.setHeader("Idempotency-Replayed", "false");
    const capture = captureBufferedResponse(res, maxResponseBytes);

    res.once("finish", () => {
      void finalizeResponse(res, storageKey, fingerprint, reservationId, capture).catch(
        (error: unknown) =>
          reportBackgroundError(toGuardError(error), req, res, next, options.onError)
      );
    });

    next();
  }

  async function finalizeResponse(
    res: Response,
    storageKey: string,
    fingerprint: string,
    reservationId: string,
    capture: ReturnType<typeof captureBufferedResponse>
  ): Promise<void> {
    const cachedResponse = cachedStatuses.has(res.statusCode)
      ? snapshotResponse(res, capture, replayHeaders)
      : undefined;

    if (!cachedResponse) {
      await storeCall(() => storage.delete(storageKey, reservationId));
      return;
    }

    const completed: CompletedEntry = {
      state: "complete",
      fingerprint,
      reservationId,
      expiresAt: Date.now() + ttl,
      response: cachedResponse
    };
    await storeCall(() => storage.set(storageKey, completed, ttl, reservationId));
  }
}

function assertSameFingerprint(entry: StoreEntry, fingerprint: string): void {
  if (entry.fingerprint !== fingerprint) {
    throw new GuardError(
      "KEY_REUSED",
      "This idempotency key was already used with a different request.",
      409
    );
  }
}

function replayResponse(res: Response, entry: Extract<StoreEntry, { state: "complete" }>): void {
  res.statusCode = entry.response.statusCode;
  for (const [name, value] of Object.entries(entry.response.headers)) res.setHeader(name, value);
  res.setHeader("Idempotency-Replayed", "true");
  res.end(Buffer.from(entry.response.body));
}

function handleRequestError(
  error: ReturnType<typeof toGuardError>,
  req: Request,
  res: Response,
  next: NextFunction,
  onError?: IdempotencyGuardOptions["onError"]
): void {
  if (error.code === "REQUEST_IN_PROGRESS") res.setHeader("Retry-After", "1");

  if (onError) {
    try {
      onError(error, req, res, next);
    } catch (handlerError) {
      next(handlerError);
    }
    return;
  }

  if (res.headersSent) {
    next(error);
    return;
  }

  res
    .status(error.statusCode)
    .type("application/json")
    .json({
      error: { code: error.code, message: error.message }
    });
}

function reportBackgroundError(
  error: ReturnType<typeof toGuardError>,
  req: Request,
  res: Response,
  next: NextFunction,
  onError?: IdempotencyGuardOptions["onError"]
): void {
  if (onError) {
    try {
      onError(error, req, res, next);
      return;
    } catch (handlerError) {
      process.emitWarning(handlerError instanceof Error ? handlerError : String(handlerError));
      return;
    }
  }
  process.emitWarning(error);
}

async function storeCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof StoreCapacityError) throw toGuardError(error);
    throw new GuardError("STORE_UNAVAILABLE", "Idempotency storage is unavailable.", 503, {
      cause: error
    });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
