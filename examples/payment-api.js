import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { idempotencyGuard } from "express-idempotency-guard";

const app = express();
app.use(express.json());

// Replace this demonstration identity with the value set by real authentication middleware.
app.use((req, _res, next) => {
  req.user = { id: "user_42" };
  next();
});

// Demo stand-in for a payment provider that stores results by idempotency key.
const providerResults = new Map();
const paymentProvider = {
  async create(input, { idempotencyKey }) {
    const existing = providerResults.get(idempotencyKey);
    if (existing) return existing;

    const payment = {
      id: `payment_${randomUUID()}`,
      amount: input.amount,
      currency: input.currency,
      status: "created"
    };
    providerResults.set(idempotencyKey, payment);
    return payment;
  }
};

function providerKeyFor(userId, clientKey) {
  return createHash("sha256").update(`${userId}\0${clientKey}`).digest("hex");
}

app.post(
  "/payments",
  idempotencyGuard({
    ttl: 24 * 60 * 60 * 1000,
    methods: ["POST"],
    keyScope: (req) => req.user.id
  }),
  async (req, res, next) => {
    try {
      const payment = await paymentProvider.create(req.body, {
        idempotencyKey: providerKeyFor(req.user.id, req.get("Idempotency-Key"))
      });
      res.status(201).json(payment);
    } catch (error) {
      next(error);
    }
  }
);

app.listen(3000, () => {
  process.stdout.write("Payment example listening on http://localhost:3000\n");
});
