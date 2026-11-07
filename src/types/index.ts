import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface CachedResponse {
  statusCode: number;
  headers: Record<string, string | number | string[]>;
  body: Uint8Array;
}

export interface PendingEntry {
  state: "pending";
  fingerprint: string;
  reservationId: string;
  expiresAt: number;
}

export interface CompletedEntry {
  state: "complete";
  fingerprint: string;
  reservationId: string;
  expiresAt: number;
  response: CachedResponse;
}

export type StoreEntry = PendingEntry | CompletedEntry;

export type ReserveResult = { acquired: true } | { acquired: false; entry: StoreEntry };

/**
 * Storage contract used by the middleware.
 *
 * `reserve` must atomically create a pending entry only when the key is absent
 * or expired. `set` and `delete` must only affect the entry with the matching
 * reservation ID so an expired worker cannot overwrite a newer reservation.
 * Implementations shared across processes must provide these guarantees in the
 * shared backend; the built-in MemoryStore only coordinates one process.
 */
export interface IdempotencyStore {
  get(key: string): Promise<StoreEntry | undefined>;
  reserve(key: string, entry: PendingEntry, ttl: number): Promise<ReserveResult>;
  set(key: string, entry: CompletedEntry, ttl: number, reservationId: string): Promise<boolean>;
  delete(key: string, reservationId?: string): Promise<boolean>;
}

export type RequestFingerprint = (req: Request) => string | Promise<string>;
export type RequestScope = (req: Request) => string;

export interface IdempotencyGuardError extends Error {
  code: string;
  statusCode: number;
}

export type IdempotencyErrorHandler = (
  error: IdempotencyGuardError,
  req: Request,
  res: Response,
  next: NextFunction
) => void;

export interface IdempotencyGuardOptions {
  /** Lifetime of completed records and pending reservations, in milliseconds. Defaults to 24 hours. */
  ttl?: number;
  /** Request header containing the operation key. Defaults to `Idempotency-Key`. */
  headerName?: string;
  /** HTTP methods protected by the middleware. Defaults to `POST` and `PATCH`. */
  methods?: readonly string[];
  /** Storage adapter. Defaults to a bounded in-memory store for this middleware instance. */
  storage?: IdempotencyStore;
  /** Custom body component for the fingerprint; method, URL, and route are still included. */
  fingerprint?: RequestFingerprint;
  /** Optional caller or tenant namespace. Use authenticated identity, not an untrusted header. */
  keyScope?: RequestScope;
  /** Maximum accepted key length in ASCII characters. Defaults to 255. */
  maxKeyLength?: number;
  /** Maximum canonical fingerprint input size. Defaults to 1 MiB. */
  maxFingerprintBytes?: number;
  /** Maximum response body size eligible for replay. Defaults to 1 MiB. */
  maxResponseBytes?: number;
  /** Status codes whose responses may be cached. Defaults to 200 through 299. */
  statusCodesToCache?: readonly number[];
  /** If false, requests without a key pass through without idempotency protection. Defaults to true. */
  requireKey?: boolean;
  /** Status for a matching request that is still waiting on the first operation. Defaults to 409. */
  inProgressStatusCode?: number;
  /** How long matching concurrent requests wait for the first response. Defaults to 30 seconds. */
  inProgressWaitMs?: number;
  /** Poll interval while waiting for a pending operation. Defaults to 25 milliseconds. */
  pollIntervalMs?: number;
  /** Safe response headers to replay. `set-cookie` and hop-by-hop headers are always excluded. */
  responseHeaders?: readonly string[];
  /** Return true to bypass this middleware for a request. */
  skip?: (req: Request) => boolean;
  /** Override default JSON errors. Called for request-time failures and post-response storage failures. */
  onError?: IdempotencyErrorHandler;
}

export type IdempotencyGuard = RequestHandler;

export interface MemoryStoreOptions {
  /** Maximum live records. Capacity exhaustion fails closed with a storage error. Defaults to 10,000. */
  maxEntries?: number;
  /** Maximum estimated stored bytes. Defaults to 64 MiB. */
  maxBytes?: number;
  /** Background expired-record sweep interval. Defaults to 60 seconds. */
  cleanupIntervalMs?: number;
}
