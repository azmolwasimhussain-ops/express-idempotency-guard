import { StoreCapacityError } from "../core/errors.js";
import type {
  CompletedEntry,
  IdempotencyStore,
  MemoryStoreOptions,
  PendingEntry,
  ReserveResult,
  StoreEntry
} from "../types/index.js";

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

/**
 * A bounded, single-process store. It is suitable for local development and
 * single-process deployments; it does not coordinate across Node.js processes.
 */
export class MemoryStore implements IdempotencyStore {
  private readonly entries = new Map<string, StoreEntry>();
  private readonly entrySizes = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private storedBytes = 0;
  private readonly cleanupTimer: NodeJS.Timeout;

  public constructor(options: MemoryStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new TypeError("maxEntries must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new TypeError("maxBytes must be a positive integer.");
    }
    if (
      !Number.isFinite(cleanupIntervalMs) ||
      cleanupIntervalMs <= 0 ||
      cleanupIntervalMs > 2_147_483_647
    ) {
      throw new TypeError("cleanupIntervalMs must be from 1 to 2,147,483,647 milliseconds.");
    }

    this.cleanupTimer = setInterval(() => this.pruneExpired(), cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  public get size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  public get sizeInBytes(): number {
    this.pruneExpired();
    return this.storedBytes;
  }

  public async get(key: string): Promise<StoreEntry | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.removeEntry(key);
      return undefined;
    }
    return cloneEntry(entry);
  }

  public async reserve(key: string, entry: PendingEntry, ttl: number): Promise<ReserveResult> {
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > Date.now()) {
      return { acquired: false, entry: cloneEntry(existing) };
    }
    if (existing) this.removeEntry(key);

    this.pruneExpired();
    if (
      this.entries.size >= this.maxEntries ||
      this.storedBytes + estimateEntryBytes(entry) > this.maxBytes
    ) {
      throw new StoreCapacityError();
    }

    this.writeEntry(key, {
      ...entry,
      state: "pending",
      expiresAt: Date.now() + ttl
    });
    return { acquired: true };
  }

  public async set(
    key: string,
    entry: CompletedEntry,
    ttl: number,
    reservationId: string
  ): Promise<boolean> {
    const current = this.entries.get(key);
    if (
      !current ||
      current.expiresAt <= Date.now() ||
      current.state !== "pending" ||
      current.reservationId !== reservationId
    ) {
      return false;
    }

    const completed: CompletedEntry = {
      ...entry,
      state: "complete",
      expiresAt: Date.now() + ttl,
      response: {
        statusCode: entry.response.statusCode,
        headers: cloneHeaders(entry.response.headers),
        body: new Uint8Array(entry.response.body)
      }
    };
    const currentSize = this.entrySizes.get(key) ?? 0;
    if (this.storedBytes - currentSize + estimateEntryBytes(completed) > this.maxBytes) {
      this.removeEntry(key);
      return false;
    }
    this.writeEntry(key, completed);
    return true;
  }

  public async delete(key: string, reservationId?: string): Promise<boolean> {
    const current = this.entries.get(key);
    if (!current) return false;
    if (reservationId !== undefined && current.reservationId !== reservationId) return false;
    return this.removeEntry(key);
  }

  /** Remove expired records now; the method is public for maintenance and tests. */
  public pruneExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        if (this.removeEntry(key)) removed += 1;
      }
    }
    return removed;
  }

  /** Stop the background sweep when an application disposes this store. */
  public close(): void {
    clearInterval(this.cleanupTimer);
  }

  private writeEntry(key: string, entry: StoreEntry): void {
    const priorSize = this.entrySizes.get(key) ?? 0;
    const size = estimateEntryBytes(entry);
    this.entries.set(key, entry);
    this.entrySizes.set(key, size);
    this.storedBytes += size - priorSize;
  }

  private removeEntry(key: string): boolean {
    const removed = this.entries.delete(key);
    if (removed) {
      this.storedBytes -= this.entrySizes.get(key) ?? 0;
      this.entrySizes.delete(key);
    }
    return removed;
  }
}

function cloneEntry(entry: StoreEntry): StoreEntry {
  if (entry.state === "pending") return { ...entry };
  return {
    ...entry,
    response: {
      statusCode: entry.response.statusCode,
      headers: cloneHeaders(entry.response.headers),
      body: new Uint8Array(entry.response.body)
    }
  };
}

function cloneHeaders(
  headers: Record<string, string | number | string[]>
): Record<string, string | number | string[]> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? [...value] : value
    ])
  );
}

function estimateEntryBytes(entry: StoreEntry): number {
  let bytes = 128 + Buffer.byteLength(entry.fingerprint) + Buffer.byteLength(entry.reservationId);
  if (entry.state === "complete") {
    bytes += entry.response.body.byteLength;
    for (const [name, value] of Object.entries(entry.response.headers)) {
      bytes += Buffer.byteLength(name);
      bytes += Buffer.byteLength(Array.isArray(value) ? value.join(",") : String(value));
    }
  }
  return bytes;
}
