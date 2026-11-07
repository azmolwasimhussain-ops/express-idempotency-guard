import { createClient } from "redis";
import { idempotencyGuard } from "express-idempotency-guard";
import express from "express";

const reserveScript = `
local current = redis.call('GET', KEYS[1])
if current then
  return { 0, current }
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
return { 1 }
`;

const completeScript = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local record = cjson.decode(current)
if record.state ~= 'pending' or record.reservationId ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`;

const deleteScript = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
if ARGV[1] ~= '' then
  local record = cjson.decode(current)
  if record.reservationId ~= ARGV[1] then return 0 end
end
return redis.call('DEL', KEYS[1])
`;

class RedisStore {
  constructor(client) {
    this.client = client;
  }

  async get(key) {
    const raw = await this.client.get(key);
    return raw === null ? undefined : decode(raw);
  }

  async reserve(key, entry, ttl) {
    const result = await this.client.eval(reserveScript, {
      keys: [key],
      arguments: [encode(entry), String(ttl)]
    });
    if (Number(result[0]) === 1) return { acquired: true };
    return { acquired: false, entry: decode(String(result[1])) };
  }

  async set(key, entry, ttl, reservationId) {
    const result = await this.client.eval(completeScript, {
      keys: [key],
      arguments: [reservationId, encode(entry), String(ttl)]
    });
    return Number(result) === 1;
  }

  async delete(key, reservationId) {
    const result = await this.client.eval(deleteScript, {
      keys: [key],
      arguments: [reservationId ?? ""]
    });
    return Number(result) === 1;
  }
}

function encode(entry) {
  if (entry.state === "pending") return JSON.stringify(entry);
  return JSON.stringify({
    ...entry,
    response: {
      ...entry.response,
      body: Buffer.from(entry.response.body).toString("base64")
    }
  });
}

function decode(serialized) {
  const entry = JSON.parse(serialized);
  if (entry.state === "complete") {
    entry.response.body = Uint8Array.from(Buffer.from(entry.response.body, "base64"));
  }
  return entry;
}

const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (error) => process.stderr.write(`Redis error: ${error.message}\n`));
await redis.connect();

const app = express();
app.use(express.json());
app.post("/payments", idempotencyGuard({ storage: new RedisStore(redis) }), (_req, res) =>
  res.status(201).json({ paymentId: "payment_123" })
);

const server = app.listen(3000);
process.once("SIGTERM", () => {
  server.close(() => void redis.quit());
});
