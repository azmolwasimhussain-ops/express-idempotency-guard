import { afterEach, describe, expect, it } from "vitest";
import express, { type RequestHandler } from "express";
import request from "supertest";
import { MemoryStore, idempotencyGuard } from "../../src/index.js";
import type { IdempotencyStore } from "../../src/types/index.js";

const stores: MemoryStore[] = [];

function memoryStore(options: ConstructorParameters<typeof MemoryStore>[0] = {}): MemoryStore {
  const store = new MemoryStore({ cleanupIntervalMs: 60_000, ...options });
  stores.push(store);
  return store;
}

function appWith(
  guard: RequestHandler,
  handler: RequestHandler,
  method: "post" | "patch" = "post",
  path = "/operations"
) {
  const app = express();
  app.use(express.json());
  app[method](path, guard, handler);
  return app;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("idempotencyGuard", () => {
  it("executes a new operation and replays the original status and body", async () => {
    let calls = 0;
    const app = appWith(idempotencyGuard({ storage: memoryStore() }), (_req, res) => {
      calls += 1;
      res.status(201).json({ operationId: "op-123", calls });
    });

    const first = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "request-1")
      .send({ amount: 10 });
    const replay = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "request-1")
      .send({ amount: 10 });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(first.headers["idempotency-replayed"]).toBe("false");
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(calls).toBe(1);
  });

  it("rejects a missing key with a structured 400 response", async () => {
    const app = appWith(idempotencyGuard({ storage: memoryStore() }), (_req, res) =>
      res.json({ ok: true })
    );

    const response = await request(app).post("/operations").send({ amount: 10 });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: "MISSING_KEY", message: "The Idempotency-Key header is required." }
    });
  });

  it("fails closed with 503 when the memory store is over capacity", async () => {
    let calls = 0;
    const app = appWith(
      idempotencyGuard({ storage: memoryStore({ maxBytes: 1 }) }),
      (_req, res) => {
        calls += 1;
        res.json({ ok: true });
      }
    );

    const response = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "capacity-key")
      .send({});

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("STORE_CAPACITY");
    expect(calls).toBe(0);
  });

  it("rejects an invalid overlong key", async () => {
    const app = appWith(
      idempotencyGuard({ storage: memoryStore(), maxKeyLength: 5 }),
      (_req, res) => res.json({ ok: true })
    );
    const response = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "123456")
      .send({});
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_KEY");
  });

  it("returns 409 when the same key is reused with a different payload", async () => {
    let calls = 0;
    const app = appWith(idempotencyGuard({ storage: memoryStore() }), (_req, res) => {
      calls += 1;
      res.json({ calls });
    });
    await request(app).post("/operations").set("Idempotency-Key", "same-key").send({ amount: 10 });
    const conflict = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "same-key")
      .send({ amount: 11 });

    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("KEY_REUSED");
    expect(conflict.body.error.message).toContain("different request");
    expect(calls).toBe(1);
  });

  it("fingerprints the HTTP method so reuse on another method conflicts", async () => {
    let calls = 0;
    const guard = idempotencyGuard({ storage: memoryStore() });
    const app = express();
    app.use(express.json());
    const handler: RequestHandler = (_req, res) => {
      calls += 1;
      res.json({ calls });
    };
    app.post("/operations", guard, handler);
    app.patch("/operations", guard, handler);

    await request(app)
      .post("/operations")
      .set("Idempotency-Key", "shared-key")
      .send({ amount: 10 });
    const differentMethod = await request(app)
      .patch("/operations")
      .set("Idempotency-Key", "shared-key")
      .send({ amount: 10 });

    expect(differentMethod.status).toBe(409);
    expect(differentMethod.body.error.code).toBe("KEY_REUSED");
    expect(calls).toBe(1);
  });

  it("waits for a concurrent duplicate and replays the first result", async () => {
    let calls = 0;
    const app = appWith(
      idempotencyGuard({ storage: memoryStore(), inProgressWaitMs: 1000, pollIntervalMs: 5 }),
      (_req, res) => {
        calls += 1;
        setTimeout(() => res.status(201).json({ operationId: "concurrent-1" }), 35);
      }
    );

    const first = request(app)
      .post("/operations")
      .set("Idempotency-Key", "racing-key")
      .send({ amount: 5 });
    const second = request(app)
      .post("/operations")
      .set("Idempotency-Key", "racing-key")
      .send({ amount: 5 });
    const [one, two] = await Promise.all([first, second]);

    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(one.body).toEqual(two.body);
    expect(calls).toBe(1);
  });

  it("returns the configured in-progress status when the wait expires", async () => {
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const app = appWith(
      idempotencyGuard({ storage: memoryStore(), inProgressWaitMs: 0, inProgressStatusCode: 425 }),
      (_req, res) => {
        startedResolve?.();
        setTimeout(() => res.json({ complete: true }), 50);
      }
    );

    const firstPromise = request(app)
      .post("/operations")
      .set("Idempotency-Key", "busy-key")
      .send({ value: 1 })
      .then((response) => response);
    await started;
    const second = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "busy-key")
      .send({ value: 1 });
    const first = await firstPromise;

    expect(second.status).toBe(425);
    expect(second.headers["retry-after"]).toBe("1");
    expect(second.body.error.code).toBe("REQUEST_IN_PROGRESS");
    expect(first.status).toBe(200);
  });

  it("releases failed 5xx responses so a retry can execute", async () => {
    let calls = 0;
    const app = express();
    app.use(express.json());
    app.post("/operations", idempotencyGuard({ storage: memoryStore() }), (_req, res, next) => {
      calls += 1;
      if (calls === 1) {
        next(new Error("temporary failure"));
        return;
      }
      res.status(201).json({ success: true });
    });
    app.use(
      (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        void _next;
        res.status(500).json({ error: error.message });
      }
    );

    const failed = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "retry-key")
      .send({});
    const retry = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "retry-key")
      .send({});

    expect(failed.status).toBe(500);
    expect(retry.status).toBe(201);
    expect(calls).toBe(2);
  });

  it("does not replay unsafe or unapproved response headers", async () => {
    let calls = 0;
    const app = appWith(idempotencyGuard({ storage: memoryStore() }), (_req, res) => {
      calls += 1;
      res.setHeader("X-Private", "secret");
      res.cookie("session", "private-value");
      res.json({ calls });
    });
    await request(app).post("/operations").set("Idempotency-Key", "headers-key").send({});
    const replay = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "headers-key")
      .send({});

    expect(replay.headers["x-private"]).toBeUndefined();
    expect(replay.headers["set-cookie"]).toBeUndefined();
    expect(replay.headers["content-type"]).toContain("application/json");
    expect(calls).toBe(1);
  });

  it("supports a custom key header and optional scope", async () => {
    let calls = 0;
    const app = appWith(
      idempotencyGuard({
        storage: memoryStore(),
        headerName: "X-Operation-Key",
        keyScope: (req) => String(req.get("X-Tenant") ?? "anonymous")
      }),
      (_req, res) => {
        calls += 1;
        res.json({ calls });
      }
    );
    const first = await request(app)
      .post("/operations")
      .set("X-Operation-Key", "same")
      .set("X-Tenant", "tenant-a")
      .send({});
    const anotherTenant = await request(app)
      .post("/operations")
      .set("X-Operation-Key", "same")
      .set("X-Tenant", "tenant-b")
      .send({});
    const replay = await request(app)
      .post("/operations")
      .set("X-Operation-Key", "same")
      .set("X-Tenant", "tenant-a")
      .send({});

    expect(first.body.calls).toBe(1);
    expect(anotherTenant.body.calls).toBe(2);
    expect(replay.body.calls).toBe(1);
    expect(calls).toBe(2);
  });

  it("keeps different keys independent", async () => {
    let calls = 0;
    const app = appWith(idempotencyGuard({ storage: memoryStore() }), (_req, res) => {
      calls += 1;
      res.json({ calls });
    });
    const first = await request(app).post("/operations").set("Idempotency-Key", "key-a").send({});
    const second = await request(app).post("/operations").set("Idempotency-Key", "key-b").send({});
    const replay = await request(app).post("/operations").set("Idempotency-Key", "key-a").send({});

    expect(first.body.calls).toBe(1);
    expect(second.body.calls).toBe(2);
    expect(replay.body.calls).toBe(1);
    expect(calls).toBe(2);
  });

  it("allows missing keys when required-key enforcement is disabled", async () => {
    const app = appWith(
      idempotencyGuard({ storage: memoryStore(), requireKey: false }),
      (_req, res) => res.json({ ok: true })
    );
    const response = await request(app).post("/operations").send({});
    expect(response.status).toBe(200);
  });

  it("bypasses an explicitly skipped route", async () => {
    const guard = idempotencyGuard({ storage: memoryStore(), skip: (req) => req.path === "/skip" });
    const app = express();
    app.use(express.json());
    app.post("/skip", guard, (_req, res) => res.json({ skipped: true }));
    const response = await request(app).post("/skip").send({});
    expect(response.status).toBe(200);
    expect(response.body.skipped).toBe(true);
  });

  it("uses a custom error handler", async () => {
    const app = appWith(
      idempotencyGuard({
        storage: memoryStore(),
        onError: (error, _req, res, _next) => {
          void _next;
          res.status(422).json({ customCode: error.code });
        }
      }),
      (_req, res) => res.json({ ok: true })
    );
    const response = await request(app).post("/operations").send({});
    expect(response.status).toBe(422);
    expect(response.body).toEqual({ customCode: "MISSING_KEY" });
  });

  it("can cache a configured non-2xx status", async () => {
    let calls = 0;
    const app = appWith(
      idempotencyGuard({ storage: memoryStore(), statusCodesToCache: [400] }),
      (_req, res) => {
        calls += 1;
        res.status(400).json({ calls });
      }
    );
    const first = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "bad-request")
      .send({});
    const replay = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "bad-request")
      .send({});
    expect(first.status).toBe(400);
    expect(replay.body).toEqual(first.body);
    expect(calls).toBe(1);
  });

  it("uses a custom fingerprint for the body component", async () => {
    let calls = 0;
    const app = appWith(
      idempotencyGuard({
        storage: memoryStore(),
        fingerprint: (req) => String(req.body.operationId)
      }),
      (_req, res) => {
        calls += 1;
        res.json({ operationId: "op-1", calls });
      }
    );
    await request(app)
      .post("/operations")
      .set("Idempotency-Key", "custom-fingerprint")
      .send({ operationId: "op-1", traceId: "first" });
    const replay = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "custom-fingerprint")
      .send({ operationId: "op-1", traceId: "second" });

    expect(replay.body).toEqual({ operationId: "op-1", calls: 1 });
    expect(calls).toBe(1);
  });

  it("expires completed responses after the configured TTL", async () => {
    let calls = 0;
    const app = appWith(idempotencyGuard({ storage: memoryStore(), ttl: 25 }), (_req, res) => {
      calls += 1;
      res.json({ calls });
    });
    const first = await request(app).post("/operations").set("Idempotency-Key", "ttl-key").send({});
    await new Promise((resolve) => setTimeout(resolve, 35));
    const afterExpiry = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "ttl-key")
      .send({});

    expect(first.body.calls).toBe(1);
    expect(afterExpiry.body.calls).toBe(2);
    expect(calls).toBe(2);
  });

  it("does not cache streaming responses", async () => {
    let calls = 0;
    const app = appWith(idempotencyGuard({ storage: memoryStore() }), (_req, res) => {
      calls += 1;
      res.write("chunk-");
      res.end("done");
    });
    const first = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "stream-key")
      .send({});
    const second = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "stream-key")
      .send({});
    expect(first.text).toBe("chunk-done");
    expect(second.text).toBe("chunk-done");
    expect(calls).toBe(2);
  });

  it("delivers oversized responses without caching them", async () => {
    let calls = 0;
    const app = appWith(
      idempotencyGuard({ storage: memoryStore(), maxResponseBytes: 4 }),
      (_req, res) => {
        calls += 1;
        res.status(201).type("text").send(`response-${calls}`);
      }
    );

    const first = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "oversized-key")
      .send({});
    const second = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "oversized-key")
      .send({});

    expect(first.status).toBe(201);
    expect(first.text).toBe("response-1");
    expect(second.text).toBe("response-2");
    expect(second.headers["idempotency-replayed"]).toBe("false");
    expect(calls).toBe(2);
  });

  it("supports custom storage adapters", async () => {
    const backing = memoryStore();
    const storage: IdempotencyStore = {
      get: (key) => backing.get(key),
      reserve: (key, entry, ttl) => backing.reserve(key, entry, ttl),
      set: (key, entry, ttl, reservationId) => backing.set(key, entry, ttl, reservationId),
      delete: (key, reservationId) => backing.delete(key, reservationId)
    };
    let calls = 0;
    const app = appWith(idempotencyGuard({ storage }), (_req, res) => {
      calls += 1;
      res.json({ calls });
    });
    await request(app).post("/operations").set("Idempotency-Key", "adapter-key").send({});
    const replay = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "adapter-key")
      .send({});
    expect(replay.body.calls).toBe(1);
    expect(calls).toBe(1);
  });

  it("supports Express 5 at runtime", async () => {
    const require = (await import("node:module")).createRequire(import.meta.url);
    const express5 = require("express5") as typeof import("express");
    const app = express5();
    app.use(express5.json());
    app.post(
      "/operations",
      idempotencyGuard({ storage: memoryStore() }),
      (_req: express.Request, res: express.Response) => res.status(201).json({ ok: true })
    );

    const response = await request(app)
      .post("/operations")
      .set("Idempotency-Key", "express-5")
      .send({ amount: 1 });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ ok: true });
  });
});
