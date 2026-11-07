import type { IdempotencyGuardError } from "../types/index.js";

export class GuardError extends Error implements IdempotencyGuardError {
  public readonly code: string;
  public readonly statusCode: number;

  public constructor(code: string, message: string, statusCode: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "IdempotencyGuardError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class StoreCapacityError extends Error {
  public constructor() {
    super("The in-memory idempotency store has reached its configured capacity.");
    this.name = "StoreCapacityError";
  }
}

export function toGuardError(error: unknown): GuardError {
  if (error instanceof GuardError) return error;

  if (error instanceof StoreCapacityError) {
    return new GuardError(
      "STORE_CAPACITY",
      "Idempotency storage is at capacity; retry the request later.",
      503,
      { cause: error }
    );
  }

  return new GuardError("INTERNAL_ERROR", "The idempotency request could not be processed.", 500, {
    cause: error
  });
}
