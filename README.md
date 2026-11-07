# express-idempotency-guard

**One request. One operation. No accidental duplicates.**

`express-idempotency-guard` is Express middleware for making retryable API operations safer. It uses an `Idempotency-Key` header, a request fingerprint, an atomic storage reservation, and a bounded response cache to prevent duplicate handlers from running for the same operation.

**Repository:** [azmolwasimhussain-ops/express-idempotency-guard](https://github.com/azmolwasimhussain-ops/express-idempotency-guard) · [Issues](https://github.com/azmolwasimhussain-ops/express-idempotency-guard/issues) · [Security policy](https://github.com/azmolwasimhussain-ops/express-idempotency-guard/blob/main/SECURITY.md)

## Why this package exists

Clients retry when a connection fails or a response is lost. The server may already have completed the operation, so running the handler again can create a second order, payment, or other side effect. This middleware records the first operation and replays its buffered response to a matching retry.

The key identifies one logical operation. A client should generate it once and reuse it for retries of that operation. A new key on every attempt defeats deduplication.

## Features

- Require an idempotency key for configured HTTP methods.
- Fingerprint the method, route, URL, content type, and canonicalized request body.
- Reject reuse of a key with a different request using `409 Conflict`.
- Atomically reserve a key and wait for an in-flight matching request.
- Replay the saved status, body, and explicitly allowed response headers.
- Release reservations for responses not selected for caching, including default 5xx responses.
- Configure TTL, methods, header name, storage, fingerprinting, tenant scope, and error handling.
- Use a bounded in-memory store for a single Node.js process, or provide a custom adapter.
- Build ESM and CommonJS exports with TypeScript declarations.

## Requirements

- Node.js `>=22.18.0` (including current Node.js 22, 24, and newer releases).
- Express `4.18+` or `5.x` as a peer dependency.
- A JSON or other body parser before the idempotency middleware for requests with bodies.

## Installation

```sh
npm install express-idempotency-guard express
```

The package does not bundle Express. Install Express in your application.

## Quick start

```js
import express from "express";
import { idempotencyGuard } from "express-idempotency-guard";

const app = express();

app.use(express.json());

app.post(
  "/payments",
  idempotencyGuard({
    ttl: 24 * 60 * 60 * 1000,
    methods: ["POST", "PATCH"]
  }),
  async (req, res) => {
    const payment = await createPayment(req.body);
    res.status(201).json(payment);
  }
);

app.listen(3000);
```

Send the same key when retrying the same operation:

```sh
curl -X POST http://localhost:3000/payments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 8e03978e-40d5-43e8-bc93-6894a57f9324' \
  -d '{"amount":2500,"currency":"USD"}'
```

The first response includes `Idempotency-Replayed: false`; a replay includes `Idempotency-Replayed: true`.

## JavaScript CommonJS

```js
const express = require("express");
const { idempotencyGuard } = require("express-idempotency-guard");

const app = express();
app.use(express.json());

app.post("/orders", idempotencyGuard(), (req, res) => {
  res.status(201).json({ orderId: "order_123", item: req.body.item });
});

app.listen(3000);
```

## JavaScript ESM

```js
import express from "express";
import { idempotencyGuard } from "express-idempotency-guard";

const app = express();
app.use(express.json());
app.post("/orders", idempotencyGuard(), (_req, res) =>
  res.status(201).json({ orderId: "order_123" })
);
app.listen(3000);
```

## TypeScript

```ts
import express from "express";
import { idempotencyGuard, type IdempotencyGuardOptions } from "express-idempotency-guard";

const app = express();
app.use(express.json());

const guardOptions: IdempotencyGuardOptions = {
  ttl: 60 * 60 * 1000,
  methods: ["POST", "PATCH"],
  keyScope: (req) => req.user.id
};

app.post("/orders", idempotencyGuard(guardOptions), async (req, res) => {
  const order = await createOrder(req.body);
  res.status(201).json(order);
});
```

The `req.user` type in this example is supplied by the application's authentication middleware and its Express type augmentation.

## Payment API example

```ts
app.post(
  "/payments",
  authenticate,
  idempotencyGuard({
    methods: ["POST"],
    ttl: 24 * 60 * 60 * 1000,
    keyScope: (req) => req.user.id
  }),
  async (req, res) => {
    const payment = await paymentProvider.create(req.body, {
      idempotencyKey: req.get("Idempotency-Key")
    });
    res.status(201).json(payment);
  }
);
```

Use your payment provider's own idempotency support for the external charge. Middleware storage and a payment provider usually cannot commit in one transaction; provider-level deduplication or a transactional outbox can protect that failure boundary.

Runnable examples are in the [examples directory](https://github.com/azmolwasimhussain-ops/express-idempotency-guard/tree/main/examples).

## Configuration reference

```ts
interface IdempotencyGuardOptions {
  ttl?: number;
  headerName?: string;
  methods?: readonly string[];
  storage?: IdempotencyStore;
  fingerprint?: (req: Request) => string | Promise<string>;
  keyScope?: (req: Request) => string;
  maxKeyLength?: number;
  maxFingerprintBytes?: number;
  maxResponseBytes?: number;
  statusCodesToCache?: readonly number[];
  requireKey?: boolean;
  inProgressStatusCode?: number;
  inProgressWaitMs?: number;
  pollIntervalMs?: number;
  responseHeaders?: readonly string[];
  skip?: (req: Request) => boolean;
  onError?: (error, req, res, next) => void;
}
```

| Option                 | Default                                                                         | Description                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ttl`                  | `86400000`                                                                      | Lifetime in milliseconds for a completed result and its in-progress reservation.                                         |
| `headerName`           | `Idempotency-Key`                                                               | Request header carrying the client-generated key.                                                                        |
| `methods`              | `POST`, `PATCH`                                                                 | Methods protected by the middleware. Other methods pass through.                                                         |
| `storage`              | `new MemoryStore()`                                                             | Store implementing the atomic reservation contract.                                                                      |
| `fingerprint`          | Canonical request body                                                          | Custom body fingerprint input. Method, route, and URL remain part of the fingerprint.                                    |
| `keyScope`             | `""`                                                                            | Trusted namespace such as authenticated user or tenant ID.                                                               |
| `maxKeyLength`         | `255`                                                                           | Maximum visible ASCII characters accepted in the key.                                                                    |
| `maxFingerprintBytes`  | `1048576`                                                                       | Maximum canonical fingerprint input size; larger requests receive `413`.                                                 |
| `maxResponseBytes`     | `1048576`                                                                       | Maximum buffered response body eligible for replay. Larger responses are delivered but not cached.                       |
| `statusCodesToCache`   | `200` through `299`                                                             | Completed response statuses to keep. 5xx errors are excluded by default.                                                 |
| `requireKey`           | `true`                                                                          | Missing keys receive `400`; set false to pass missing-key requests through unprotected.                                  |
| `inProgressStatusCode` | `409`                                                                           | Status returned when a matching request is still running after the wait window.                                          |
| `inProgressWaitMs`     | `30000`                                                                         | Maximum wait for a matching in-flight request to complete.                                                               |
| `pollIntervalMs`       | `25`                                                                            | Store polling interval while waiting for completion.                                                                     |
| `responseHeaders`      | `content-type`, `etag`, `location`, `cache-control`, `expires`, `last-modified` | Response headers allowed in a replay. Unsafe hop-by-hop and cookie headers cannot be added.                              |
| `skip`                 | —                                                                               | Return true to bypass this middleware for a selected request.                                                            |
| `onError`              | Built-in JSON response                                                          | Override how middleware errors are handled. It also receives storage failures after the original response has been sent. |

### Configuration validation

Invalid static options throw a `TypeError` when `idempotencyGuard()` is created:

- `ttl` and `pollIntervalMs` must be positive finite numbers; `inProgressWaitMs` must be finite and non-negative.
- `maxKeyLength`, `maxFingerprintBytes`, and `maxResponseBytes` must be positive safe integers.
- `methods` must contain one or more valid HTTP method tokens. `statusCodesToCache` values must be integers from `200` to `599`, and `inProgressStatusCode` must be from `400` to `599`.
- `headerName` and each `responseHeaders` entry must be valid HTTP header names. Unsafe response headers such as `set-cookie`, `content-length`, and hop-by-hop headers are rejected.

At request time, keys must contain 1 to `maxKeyLength` visible ASCII characters. A `keyScope` callback and a custom `fingerprint` callback must each return a string.

`keyScope` should use a trusted identity established before this middleware. Without a scope, callers who share a key and identical request across users share a deduplication record. Do not derive scope from an untrusted header.

The default fingerprint sorts object keys and includes the method, matched route, original URL, content type, and request body. Install a body parser before the guard. The application remains responsible for limiting the body size at the parser.

## Storage adapters

The public `IdempotencyStore` interface is:

```ts
interface IdempotencyStore {
  get(key: string): Promise<StoreEntry | undefined>;
  reserve(key: string, entry: PendingEntry, ttl: number): Promise<ReserveResult>;
  set(key: string, entry: CompletedEntry, ttl: number, reservationId: string): Promise<boolean>;
  delete(key: string, reservationId?: string): Promise<boolean>;
}
```

`reserve` must be atomic: exactly one contender may create a pending entry while the key is absent or expired. `set` and token-scoped `delete` must compare `reservationId` so an older operation cannot overwrite or remove a newer reservation after its TTL expires. `get` must expose pending entries promptly because duplicate callers poll it until the original completes or releases its reservation.

`MemoryStore` implements this contract within one Node.js process. It defaults to at most 10,000 records and an estimated 64 MiB of stored entries, sweeps expired records, clones stored response data, and fails closed when full. Call `close()` on an explicitly created `MemoryStore` when disposing it.

[`examples/custom-storage.js`](examples/custom-storage.js) shows a Redis adapter using atomic Lua scripts and the Node Redis client. It is an example, not a bundled dependency or an operational service. Configure Redis authentication, persistence, eviction, availability, and key namespace for your deployment.

| Storage                | Coordination                                                                  | Appropriate use                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Built-in `MemoryStore` | One process only; separate workers have separate records.                     | Development, tests, and a single-process service where process-local protection is acceptable.       |
| Custom shared adapter  | Depends on its atomic reservation, completion, expiry, and failure semantics. | Multi-process or multi-instance deployment when the backend is configured to share those guarantees. |

This package does not make a claim about relative throughput. Backend choice and performance depend on the workload, deployment, and storage service.

## Concurrency behavior

The first request atomically reserves the key, then reaches the route handler. A matching request arriving during that operation waits for the saved response. If the wait expires, it receives the configured in-progress status with `Retry-After: 1`. A request with a different fingerprint receives `409 Conflict` immediately.

The pending reservation expires after `ttl`. Set `ttl` longer than the maximum time your handlers can run. If a handler is still executing after its reservation expires, another retry may begin; this is a storage lease and cannot cancel the original operation.

## TTL and failed operations

TTL is measured in milliseconds. A completed result's TTL starts when the response is finished and stored. Pending reservations use the same TTL to prevent a handler that never finishes from locking a key forever.

Only configured response statuses are retained. By default this is the 2xx range, so 5xx responses release their reservation and can be retried. Add specific 4xx statuses only if replaying those responses matches your API's behavior. Avoid configuring transient 5xx statuses for caching.

## Errors and HTTP status codes

Errors use this JSON shape by default:

```json
{
  "error": {
    "code": "KEY_REUSED",
    "message": "This idempotency key was already used with a different request."
  }
}
```

| Condition                                     | Default status | Code                                   |
| --------------------------------------------- | -------------: | -------------------------------------- |
| Required key is missing                       |          `400` | `MISSING_KEY`                          |
| Key is malformed or too long                  |          `400` | `INVALID_KEY`                          |
| Body is not parsed before the guard           |          `400` | `BODY_NOT_PARSED`                      |
| Fingerprint input exceeds its limit           |          `413` | `FINGERPRINT_TOO_LARGE`                |
| Same key has a different method, URL, or body |          `409` | `KEY_REUSED`                           |
| Matching operation remains in progress        |          `409` | `REQUEST_IN_PROGRESS`                  |
| Store is full or unavailable                  |          `503` | `STORE_CAPACITY` / `STORE_UNAVAILABLE` |

Provide `onError(error, req, res, next)` to send an application-specific response or pass the error to an Express error handler. A storage error after the original response is sent cannot change that response; the callback can record it for monitoring. Without a custom handler, post-response storage failures are surfaced with `process.emitWarning`.

## Security and response safety

- Use unpredictable keys and reuse one key for retries of the same logical operation.
- Scope keys to an authenticated user or tenant in multi-tenant systems.
- Keep authentication middleware before a guard whose `keyScope` reads authenticated identity.
- The store key is a SHA-256 hash of scope and caller key; request bodies and cached response bodies are still stored as supplied.
- The default replay list excludes `Set-Cookie`, authentication headers, `Content-Length`, `Content-Encoding`, and hop-by-hop headers. These unsafe headers cannot be added to the allowlist.
- The middleware buffers one response body up to `maxResponseBytes`. It does not replay `res.write` streams, compressed responses, server-sent events, file downloads, or other streaming output.
- Client disconnects do not release a pending reservation because the operation may still be running. The reservation expires according to `ttl`.
- The middleware cannot make an external side effect and a separate store write atomic. Use downstream idempotency, a database transaction, or an outbox for critical operations.
- With Express 4, rejected promises from async route handlers are not automatically forwarded to error middleware. Use an Express 4 async wrapper or call `next(error)` so a failed operation can return a response and release its reservation.

## Limitations

- The built-in memory store is not shared across processes or hosts and is cleared when the process restarts.
- A custom adapter must implement atomic reservation and owner-checked completion; an ordinary `get` followed by `set` is not sufficient.
- If the process crashes after a side effect succeeds but before the result is stored, a later retry may repeat that side effect. Coordinate with the side-effect system.
- Streams and responses exceeding `maxResponseBytes` are returned normally but are not cached.
- The request body must be parsed before the middleware; use Express parser limits to control request memory usage.
- The middleware fingerprints the URL including its query string, so query-string ordering differences produce different fingerprints.

## Performance considerations

Fingerprinting serializes the parsed body and hashes the resulting bytes. Keep parser limits and `maxFingerprintBytes` appropriate to the endpoint. Response caching uses memory proportional to active records and response sizes, bounded in the built-in adapter by `maxEntries` and `maxResponseBytes`. The default in-flight strategy polls the store; high-contention shared adapters may prefer a notification mechanism in their own surrounding infrastructure.

## Development

```sh
npm install
npm run lint
npm run format
npm run typecheck
npm test
npm run build
npm run pack
npm run pack:check
```

See the [contributor guide](https://github.com/azmolwasimhussain-ops/express-idempotency-guard/blob/main/CONTRIBUTING.md) for the contributor workflow. Tests use Vitest and Supertest.

## API reference

- `idempotencyGuard(options?)`: create the middleware.
- `MemoryStore(options?)`: create the built-in bounded, process-local store. `close()` stops its cleanup timer, `pruneExpired()` performs a sweep, and `size` returns its live entry count.
- `GuardError`: error class used for built-in request and storage failures.
- `IdempotencyGuardOptions`, `IdempotencyStore`, `PendingEntry`, `CompletedEntry`, `StoreEntry`, `CachedResponse`, `ReserveResult`, and `MemoryStoreOptions`: exported TypeScript types.

## License

MIT. See the [LICENSE](https://github.com/azmolwasimhussain-ops/express-idempotency-guard/blob/main/LICENSE).
