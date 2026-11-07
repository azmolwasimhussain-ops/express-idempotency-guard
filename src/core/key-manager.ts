import { createHash } from "node:crypto";

/** Hash the caller key and optional trusted scope before it reaches the store. */
export function createStorageKey(scope: string, key: string): string {
  return createHash("sha256").update(`${scope}\0${key}`).digest("hex");
}
