import { createHash } from "node:crypto";
import type { Request } from "express";
import { GuardError } from "./errors.js";
import type { RequestFingerprint } from "../types/index.js";

interface FingerprintOptions {
  customFingerprint?: RequestFingerprint;
  maxBytes: number;
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? "undefined";
}

export async function createRequestFingerprint(
  req: Request,
  options: FingerprintOptions
): Promise<string> {
  const contentLength = Number(req.headers["content-length"]);
  const hasDeclaredBody =
    (Number.isFinite(contentLength) && contentLength > 0) ||
    req.headers["transfer-encoding"] !== undefined;
  if (req.body === undefined && hasDeclaredBody) {
    throw new GuardError(
      "BODY_NOT_PARSED",
      "Install an Express body parser before the idempotency middleware.",
      400
    );
  }

  const body = options.customFingerprint
    ? await options.customFingerprint(req)
    : canonicalize(req.body);

  if (typeof body !== "string") {
    throw new GuardError(
      "INVALID_FINGERPRINT",
      "The fingerprint function must return a string.",
      500
    );
  }

  const routePath = req.route?.path;
  const input = canonicalize({
    method: req.method.toUpperCase(),
    route: [req.baseUrl, routePath ?? req.path],
    url: req.originalUrl,
    contentType: req.headers["content-type"] ?? "",
    body
  });

  if (Buffer.byteLength(input, "utf8") > options.maxBytes) {
    throw new GuardError(
      "FINGERPRINT_TOO_LARGE",
      "The request is too large to fingerprint safely.",
      413
    );
  }

  return createHash("sha256").update(input).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    return value;
  }

  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString("base64") };
  }

  if (Array.isArray(value)) return value.map(sortValue);

  if (value instanceof Date) return value.toISOString();

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) sorted[key] = sortValue(item);
  }
  return sorted;
}
