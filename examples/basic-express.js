import express from "express";
import { idempotencyGuard } from "express-idempotency-guard";

const app = express();
app.use(express.json());

app.post("/payments", idempotencyGuard({ ttl: 24 * 60 * 60 * 1000 }), (req, res) => {
  res.status(201).json({
    paymentId: "payment_123",
    amount: req.body.amount,
    currency: req.body.currency
  });
});

app.listen(3000, () => {
  process.stdout.write("Example API listening on http://localhost:3000\n");
});
