import express from "express";
import { randomUUID } from "node:crypto";
import { idempotencyGuard } from "express-idempotency-guard";

const app = express();
app.use(express.json());

// Replace this demonstration identity with the value set by real authentication middleware.
app.use((req, _res, next) => {
  req.user = { id: "user_42" };
  next();
});

const payments = new Map();

app.post(
  "/payments",
  idempotencyGuard({
    ttl: 24 * 60 * 60 * 1000,
    methods: ["POST"],
    keyScope: (req) => req.user.id
  }),
  (req, res) => {
    const payment = {
      id: `payment_${randomUUID()}`,
      amount: req.body.amount,
      currency: req.body.currency,
      status: "created"
    };
    payments.set(payment.id, payment);
    res.status(201).json(payment);
  }
);

app.listen(3000, () => {
  process.stdout.write("Payment example listening on http://localhost:3000\n");
});
