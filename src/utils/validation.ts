import type { Request } from "express";
import { GuardError } from "../core/errors.js";

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const KEY_VALUE = /^[\x21-\x7e]+$/;

export function validateHeaderName(name: string): string {
  if (!TOKEN.test(name)) throw new TypeError("headerName must be a valid HTTP header name.");
  return name.toLowerCase();
}

export function validateKey(
  value: string | undefined,
  maxLength: number,
  headerName = "Idempotency-Key"
): string {
  if (value === undefined || value.length === 0) {
    throw new GuardError("MISSING_KEY", `The ${headerName} header is required.`, 400);
  }

  if (value.length > maxLength || !KEY_VALUE.test(value)) {
    throw new GuardError(
      "INVALID_KEY",
      `The ${headerName} header must contain 1 to ${maxLength} visible ASCII characters.`,
      400
    );
  }

  return value;
}

export function validateOptions(options: {
  ttl: number;
  methods: readonly string[];
  maxKeyLength: number;
  maxFingerprintBytes: number;
  maxResponseBytes: number;
  statusCodesToCache: readonly number[];
  inProgressStatusCode: number;
  inProgressWaitMs: number;
  pollIntervalMs: number;
  responseHeaders: readonly string[];
}): void {
  assertPositiveFinite("ttl", options.ttl);
  assertPositiveInteger("maxKeyLength", options.maxKeyLength);
  assertPositiveInteger("maxFingerprintBytes", options.maxFingerprintBytes);
  assertPositiveInteger("maxResponseBytes", options.maxResponseBytes);
  assertNonNegativeFinite("inProgressWaitMs", options.inProgressWaitMs);
  assertPositiveFinite("pollIntervalMs", options.pollIntervalMs);

  if (
    !Number.isSafeInteger(options.inProgressStatusCode) ||
    options.inProgressStatusCode < 400 ||
    options.inProgressStatusCode > 599
  ) {
    throw new TypeError("inProgressStatusCode must be an integer from 400 to 599.");
  }

  if (options.methods.length === 0 || options.methods.some((method) => !TOKEN.test(method))) {
    throw new TypeError("methods must contain one or more valid HTTP method tokens.");
  }

  if (
    options.statusCodesToCache.some(
      (statusCode) => !Number.isSafeInteger(statusCode) || statusCode < 200 || statusCode > 599
    )
  ) {
    throw new TypeError("statusCodesToCache must contain HTTP status codes from 200 to 599.");
  }

  for (const header of options.responseHeaders) {
    if (!TOKEN.test(header)) throw new TypeError(`Invalid response header name: ${header}`);
    const name = header.toLowerCase();
    if (UNSAFE_RESPONSE_HEADERS.has(name)) {
      throw new TypeError(`${header} cannot be configured for response replay.`);
    }
  }
}

export function validateScope(scope: string): string {
  if (typeof scope !== "string") {
    throw new GuardError("INVALID_SCOPE", "The idempotency key scope must be a string.", 500);
  }
  return scope;
}

export function isSkipped(req: Request, skip?: (req: Request) => boolean): boolean {
  return skip?.(req) ?? false;
}

const UNSAFE_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "set-cookie2",
  "authorization",
  "www-authenticate",
  "authentication-info",
  "proxy-authentication-info",
  "content-length",
  "content-range",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  "content-encoding"
]);

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0)
    throw new TypeError(`${name} must be a positive number.`);
}

function assertNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative number.`);
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive integer.`);
}
