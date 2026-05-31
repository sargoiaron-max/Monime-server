import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;

const MONIME_ACCESS_TOKEN =
  "mon_Kt9zboHu6JG8gdhEWOe2TtzeD4IDF1UPSr20mwH6jp6fejepVjSCpdQzONhQnV6B";
const MONIME_SPACE_ID = "spc-k6RSEjcc72gsqoTy82qYERpEaZH";
const MONIME_API_BASE = "https://api.monime.io";
const MONIME_VERSION = "caph.2025-08-23";

app.use(cors({ origin: "*" }));
app.use(express.json());

function monimeHeaders(idempotencyKey) {
  const headers = {
    Authorization: `Bearer ${MONIME_ACCESS_TOKEN}`,
    "Monime-Space-Id": MONIME_SPACE_ID,
    "Monime-Version": MONIME_VERSION,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  return headers;
}

async function monimeFetch(path, options = {}) {
  const url = `${MONIME_API_BASE}${path}`;
  const res = await fetch(url, options);
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    // Monime returns error as an object: { code, message, details:[{param,errors:[]}] }
    const errObj = data?.error;
    let errorMessage;
    if (typeof errObj === "string") {
      errorMessage = errObj;
    } else if (errObj && typeof errObj === "object") {
      const fieldErrors = (errObj.details || [])
        .flatMap((d) => d.errors || [])
        .join("; ");
      errorMessage = fieldErrors
        ? `${errObj.message}: ${fieldErrors}`
        : errObj.message || JSON.stringify(errObj);
    } else {
      errorMessage =
        (Array.isArray(data?.messages) && data.messages.length
          ? data.messages.join(", ")
          : null) ||
        data?.message ||
        `Monime API error (HTTP ${res.status})`;
    }
    const err = new Error(errorMessage);
    err.status = res.status;
    err.monimeData = data;
    throw err;
  }

  return data;
}

/**
 * POST /api/deposit
 * Body: { phone: "07XXXXXXXX", amount: 50, currency: "SLE" }
 *
 * Creates a Monime checkout session for the given amount.
 * Returns { checkoutUrl, sessionId } — redirect the customer to checkoutUrl
 * to complete the MoMo payment (they receive a push on their phone).
 *
 * amount is in whole SLE (e.g. 50 = SLE 50). Converted to minor units (×100) internally.
 */
app.post("/api/deposit", async (req, res) => {
  const { phone, amount, currency = "SLE" } = req.body;

  if (!phone || !amount) {
    return res.status(400).json({
      success: false,
      error: "phone and amount are required",
    });
  }

  if (typeof amount !== "number" || amount <= 0) {
    return res.status(400).json({
      success: false,
      error: "amount must be a positive number",
    });
  }

  const idempotencyKey = randomUUID();
  const amountInMinorUnits = Math.round(amount * 100);

  const body = {
    name: "Deposit",
    description: `Deposit of ${currency} ${amount} from ${phone}`,
    reference: idempotencyKey,
    lineItems: [
      {
        type: "custom",
        name: "Deposit",
        price: {
          currency,
          value: amountInMinorUnits,
        },
        quantity: 1,
      },
    ],
  };

  try {
    const data = await monimeFetch("/v1/checkout-sessions", {
      method: "POST",
      headers: monimeHeaders(idempotencyKey),
      body: JSON.stringify(body),
    });

    const session = data.result;

    return res.json({
      success: true,
      sessionId: session.id,
      checkoutUrl: session.redirectUrl,
      status: session.status,
      reference: session.reference,
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      error: err.message,
      details: err.monimeData || null,
    });
  }
});

/**
 * GET /api/deposit/status/:id
 * Returns the current status of a checkout session.
 * status can be: pending | completed | cancelled | expired
 * When completed, orderNumber is included — use it to fetch the receipt.
 */
app.get("/api/deposit/status/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const data = await monimeFetch(`/v1/checkout-sessions/${id}`, {
      method: "GET",
      headers: monimeHeaders(),
    });

    const session = data.result;

    return res.json({
      success: true,
      sessionId: session.id,
      status: session.status,
      orderNumber: session.orderNumber || null,
      reference: session.reference || null,
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      error: err.message,
      details: err.monimeData || null,
    });
  }
});

/**
 * GET /api/receipt/:orderNumber
 * Fetches the receipt for a completed payment using the order number.
 * Call this after the deposit status is "completed".
 */
app.get("/api/receipt/:orderNumber", async (req, res) => {
  const { orderNumber } = req.params;

  try {
    const data = await monimeFetch(`/v1/receipts/${orderNumber}`, {
      method: "GET",
      headers: monimeHeaders(),
    });

    return res.json({
      success: true,
      receipt: data.result,
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      error: err.message,
      details: err.monimeData || null,
    });
  }
});

/**
 * GET /api/payments
 * Lists recent payments in your Monime space.
 * Optional query params: ?limit=10&after=<cursor>
 */
app.get("/api/payments", async (req, res) => {
  const { limit = 10, after } = req.query;
  const params = new URLSearchParams({ limit });
  if (after) params.append("after", after);

  try {
    const data = await monimeFetch(`/v1/payments?${params}`, {
      method: "GET",
      headers: monimeHeaders(),
    });

    return res.json({
      success: true,
      payments: data.result,
      pagination: data.pagination,
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      error: err.message,
      details: err.monimeData || null,
    });
  }
});

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
