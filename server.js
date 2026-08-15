import express from "express";
import cors from "cors";
import { randomUUID, createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);

const MONIME_ACCESS_TOKEN = process.env.MONIME_ACCESS_TOKEN;
const MONIME_SPACE_ID = process.env.MONIME_SPACE_ID;
const MONIME_API_BASE = process.env.MONIME_API_BASE || "https://api.monime.io";
const MONIME_VERSION = process.env.MONIME_VERSION || "caph.2025-08-23";

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const SESSION_FILE = path.join(DATA_DIR, "sessions.json");
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const OFFERS = [
  {
    trackingId: "LN-10001",
    name: "Emergency Micro Credit",
    amount: 2961,
    fee: 134,
    months: 3,
    receive: 2827,
    monthly: 1013,
    available: true,
  },
  {
    trackingId: "LN-10002",
    name: "Consumer Installment Loan",
    amount: 4971,
    fee: 209,
    months: 4,
    receive: 4762,
    monthly: 1270,
    available: true,
  },
  {
    trackingId: "LN-10003",
    name: "Household Credit Advance",
    amount: 9943,
    fee: 417,
    months: 6,
    receive: 9526,
    monthly: 1707,
    available: true,
  },
  {
    trackingId: "LN-10004",
    name: "Payroll Credit Facility",
    amount: 14914,
    fee: 620,
    months: 8,
    receive: 14294,
    monthly: 1937,
    available: true,
  },
  {
    trackingId: "LN-10005",
    name: "Enterprise Development Finance",
    amount: 19886,
    fee: 824,
    months: 10,
    receive: 19062,
    monthly: 2084,
    available: true,
  },
  {
    trackingId: "LN-10006",
    name: "Structured Term Finance",
    amount: 29828,
    fee: 0,
    months: 12,
    receive: 29572,
    monthly: 2627,
    available: false,
  },
  {
    trackingId: "LN-10007",
    name: "Capital Investment Loan",
    amount: 39771,
    fee: 0,
    months: 15,
    receive: 39429,
    monthly: 2837,
    available: false,
  },
];

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "100kb" }));

function requireMonimeConfig() {
  if (!MONIME_ACCESS_TOKEN || !MONIME_SPACE_ID) {
    const error = new Error(
      "Monime is not configured. Set MONIME_ACCESS_TOKEN and MONIME_SPACE_ID."
    );
    error.status = 500;
    throw error;
  }
}

function monimeHeaders(idempotencyKey) {
  requireMonimeConfig();

  const headers = {
    Authorization: `Bearer ${MONIME_ACCESS_TOKEN}`,
    "Monime-Space-Id": MONIME_SPACE_ID,
    "Monime-Version": MONIME_VERSION,
    "Content-Type": "application/json",
  };

  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return headers;
}

async function monimeFetch(endpoint, options = {}) {
  const response = await fetch(`${MONIME_API_BASE}${endpoint}`, options);
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const errObj = data?.error;
    let message = `Monime API error (HTTP ${response.status})`;

    if (typeof errObj === "string") {
      message = errObj;
    } else if (errObj && typeof errObj === "object") {
      const fieldErrors = (errObj.details || [])
        .flatMap((item) => item.errors || [])
        .join("; ");
      message = fieldErrors
        ? `${errObj.message || "Monime error"}: ${fieldErrors}`
        : errObj.message || message;
    } else {
      message = data?.message || message;
    }

    const error = new Error(message);
    error.status = response.status;
    error.monimeData = data;
    throw error;
  }

  return data;
}

function normalizePhone(phone) {
  const raw = String(phone || "").replace(/[^\d+]/g, "");

  if (raw.startsWith("+232")) return raw;
  if (raw.startsWith("232")) return `+${raw}`;
  if (/^\d{8}$/.test(raw)) return `+232${raw}`;

  throw new Error("Phone must be a Sierra Leone number, e.g. 07234567.");
}

function normalizeNationalId(id) {
  const value = String(id || "").trim().replace(/\s+/g, " ");
  if (value.length < 4 || value.length > 64) {
    throw new Error("Invalid ID number.");
  }
  return value;
}

function hashId(id) {
  return createHash("sha256").update(id).digest("hex");
}

function formatSLE(amount) {
  return `SLE ${Number(amount).toLocaleString("en-SL")}`;
}

function findOffer(trackingId) {
  return OFFERS.find((offer) => offer.trackingId === trackingId) || null;
}

function maskPhone(phone) {
  const value = String(phone);
  return value.length > 6
    ? `${value.slice(0, 5)}****${value.slice(-2)}`
    : "****";
}

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(SESSION_FILE);
  } catch {
    await fs.writeFile(SESSION_FILE, "{}", "utf8");
  }
}

async function readSessions() {
  await ensureStore();
  const raw = await fs.readFile(SESSION_FILE, "utf8");
  return JSON.parse(raw || "{}");
}

async function writeSessions(sessions) {
  await ensureStore();
  const temp = `${SESSION_FILE}.tmp`;
  await fs.writeFile(temp, JSON.stringify(sessions, null, 2), "utf8");
  await fs.rename(temp, SESSION_FILE);
}

async function updateSession(sessionId, patch) {
  const sessions = await readSessions();
  const current = sessions[sessionId];

  if (!current) {
    const error = new Error("Session not found.");
    error.status = 404;
    throw error;
  }

  sessions[sessionId] = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  await writeSessions(sessions);
  return sessions[sessionId];
}

async function getSession(sessionId) {
  const sessions = await readSessions();
  const session = sessions[sessionId];

  if (!session) return null;

  const age = Date.now() - new Date(session.updatedAt).getTime();
  if (age > SESSION_TTL_MS) {
    delete sessions[sessionId];
    await writeSessions(sessions);
    return null;
  }

  return session;
}

async function findLatestSessionByPhone(phone) {
  const normalized = normalizePhone(phone);
  const sessions = await readSessions();

  return Object.values(sessions)
    .filter(
      (session) =>
        session.phone === normalized &&
        !["completed", "cancelled"].includes(session.status)
    )
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )[0] || null;
}

function safeSession(session) {
  if (!session) return null;

  return {
    sessionId: session.sessionId,
    phone: maskPhone(session.phone),
    step: session.step,
    status: session.status,
    nationalIdLast4: session.nationalIdLast4,
    trackingId: session.trackingId || null,
    offer: session.offer || null,
    payment: session.payment
      ? {
          paymentCodeId: session.payment.paymentCodeId,
          ussdCode: session.payment.ussdCode || null,
          amount: session.payment.amount,
          currency: "SLE",
          expiresAt: session.payment.expiresAt || null,
          reference: session.payment.reference || null,
          status: session.payment.status || "pending",
        }
      : null,
    verifiedPayment: session.verifiedPayment
      ? {
          paymentId: session.verifiedPayment.paymentId || null,
          orderNumber: session.verifiedPayment.orderNumber || null,
          financialTransactionReference:
            session.verifiedPayment.financialTransactionReference || null,
          status: session.verifiedPayment.status,
        }
      : null,
    updatedAt: session.updatedAt,
  };
}

function providerForPhone(phone) {
  // Monime documents m17 and m18 as the supported MOMO provider IDs
  // for Payment Codes. Keep this mapping configurable rather than guessing
  // an operator from every Sierra Leone prefix.
  const configured = process.env.MONIME_AUTHORIZED_PROVIDERS;
  if (configured) {
    return configured
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return ["m17", "m18"];
}

/**
 * START / RESUME
 *
 * POST /api/ussd/session/start
 * { nationalId, phone }
 *
 * A new session is created, or the latest unfinished session for the phone
 * is returned so the customer can continue where they stopped.
 */
app.post("/api/ussd/session/start", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const nationalId = normalizeNationalId(req.body.nationalId);

    const existing = await findLatestSessionByPhone(phone);

    if (existing && existing.nationalIdHash === hashId(nationalId)) {
      const resumed = await updateSession(existing.sessionId, {
        step: existing.step,
        status: existing.status,
      });

      return res.json({
        success: true,
        resumed: true,
        session: safeSession(resumed),
        message: resumeMessage(resumed),
      });
    }

    const sessionId = randomUUID();
    const now = new Date().toISOString();

    const session = {
      sessionId,
      phone,
      nationalIdHash: hashId(nationalId),
      nationalIdLast4: nationalId.slice(-4),
      step: "offer_selection",
      status: "active",
      trackingId: null,
      offer: null,
      payment: null,
      verifiedPayment: null,
      createdAt: now,
      updatedAt: now,
    };

    const sessions = await readSessions();
    sessions[sessionId] = session;
    await writeSessions(sessions);

    return res.json({
      success: true,
      resumed: false,
      session: safeSession(session),
      message: offerMenu(),
    });
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      error: error.message,
    });
  }
});

function offerMenu() {
  return [
    "SWIFT LOAN",
    "Select your loan offer:",
    "1. Emergency Micro Credit - SLE 2,961",
    "2. Consumer Installment - SLE 4,971",
    "3. Household Credit - SLE 9,943",
    "4. Payroll Credit - SLE 14,914",
    "5. Enterprise Finance - SLE 19,886",
    "6. More offers (not currently qualified)",
    "",
    "Reply with 1-5.",
  ].join("\n");
}

function resumeMessage(session) {
  if (session.status === "payment_pending" && session.payment) {
    return [
      "SWIFT LOAN",
      `Your payment is pending for ${session.trackingId}.`,
      `Amount: ${formatSLE(session.payment.amount)}`,
      "",
      "1. Show payment code",
      "2. Enter payment reference",
      "3. Check payment",
    ].join("\n");
  }

  if (session.status === "payment_verified") {
    return nextInstructions(session);
  }

  if (session.offer) {
    return confirmOfferMessage(session.offer);
  }

  return offerMenu();
}

function confirmOfferMessage(offer) {
  return [
    "SWIFT LOAN - CONFIRM",
    `${offer.name}`,
    `Loan: ${formatSLE(offer.amount)}`,
    `Fee: ${formatSLE(offer.fee)}`,
    `Receive: ${formatSLE(offer.receive)}`,
    `Monthly: ${formatSLE(offer.monthly)}`,
    `Period: ${offer.months} months`,
    `Ref: ${offer.trackingId}`,
    "",
    "1. Accept and pay fee",
    "2. Choose another",
  ].join("\n");
}

function nextInstructions(session) {
  return [
    "SWIFT LOAN",
    "PAYMENT VERIFIED",
    `Application: ${session.trackingId}`,
    `Paid: ${formatSLE(session.offer.fee)}`,
    "",
    "Next steps:",
    "1. Keep your Mobile Money number active.",
    "2. Keep your phone available for SMS/calls.",
    "3. Your application can now proceed to the next processing step.",
    "4. Wait for the official Swift Loan notification.",
    "5. Do not make another payment unless the official system requests it.",
  ].join("\n");
}

/**
 * SELECT OFFER
 *
 * POST /api/ussd/session/:sessionId/offer
 * { choice: 1-5 }
 */
app.post("/api/ussd/session/:sessionId/offer", async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ success: false, error: "Session not found or expired." });

    const choice = Number(req.body.choice);
    const offer = OFFERS[choice - 1];

    if (!offer || !offer.available) {
      return res.status(400).json({
        success: false,
        error:
          "That offer is not currently available for this session. Please choose an available offer.",
      });
    }

    const updated = await updateSession(session.sessionId, {
      trackingId: offer.trackingId,
      offer,
      step: "confirm_offer",
      status: "active",
    });

    return res.json({
      success: true,
      session: safeSession(updated),
      message: confirmOfferMessage(offer),
    });
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * CREATE PAYMENT CODE
 *
 * POST /api/ussd/session/:sessionId/payment-code
 *
 * Creates a one-time SLE Payment Code for the processing fee only.
 */
app.post("/api/ussd/session/:sessionId/payment-code", async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ success: false, error: "Session not found or expired." });

    if (!session.offer) {
      return res.status(400).json({
        success: false,
        error: "No loan offer has been selected.",
      });
    }

    if (session.offer.fee <= 0) {
      return res.status(400).json({
        success: false,
        error: "This offer does not currently have a processing fee configured.",
      });
    }

    if (session.payment?.paymentCodeId && session.status === "payment_pending") {
      return res.json({
        success: true,
        reused: true,
        session: safeSession(session),
        message: paymentMessage(session),
      });
    }

    const idempotencyKey = randomUUID();
    const reference = `SWIFT-${session.trackingId}-${session.sessionId.slice(0, 8)}`;

    const body = {
      name: `Swift Loan ${session.trackingId} Fee`,
      mode: "one_time",
      enable: true,
      amount: {
        currency: "SLE",
        value: Math.round(session.offer.fee * 100),
      },
      duration: process.env.PAYMENT_CODE_DURATION || "10m",
      customer: {
        name: "Swift Loan Customer",
      },
      reference,
      authorizedProviders: providerForPhone(session.phone),
      authorizedPhoneNumber: session.phone,
      metadata: {
        service: "swift_loan",
        trackingId: session.trackingId,
        sessionId: session.sessionId,
        nationalIdLast4: session.nationalIdLast4,
        purpose: "loan_processing_fee",
      },
    };

    const data = await monimeFetch("/v1/payment-codes", {
      method: "POST",
      headers: monimeHeaders(idempotencyKey),
      body: JSON.stringify(body),
    });

    const code = data.result;

    const updated = await updateSession(session.sessionId, {
      step: "payment_pending",
      status: "payment_pending",
      payment: {
        paymentCodeId: code.id,
        ussdCode: code.ussdCode,
        amount: session.offer.fee,
        currency: "SLE",
        expiresAt: code.expireTime,
        reference: code.reference || reference,
        status: code.status || "pending",
        createdAt: new Date().toISOString(),
      },
    });

    return res.json({
      success: true,
      session: safeSession(updated),
      message: paymentMessage(updated),
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message,
      details: error.monimeData || null,
    });
  }
});

function paymentMessage(session) {
  return [
    "SWIFT LOAN - PAYMENT",
    `Application: ${session.trackingId}`,
    `Processing fee: ${formatSLE(session.payment.amount)}`,
    "",
    `Dial: ${session.payment.ussdCode || "Payment code unavailable"}`,
    "",
    "Complete the Mobile Money payment.",
    "Then dial Swift Loan again to continue.",
    "",
    "1. Enter payment reference",
    "2. Check payment",
  ].join("\n");
}

/**
 * CHECK PAYMENT CODE
 *
 * GET /api/ussd/session/:sessionId/payment-status
 */
app.get("/api/ussd/session/:sessionId/payment-status", async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ success: false, error: "Session not found or expired." });

    if (!session.payment?.paymentCodeId) {
      return res.status(400).json({
        success: false,
        error: "No payment code exists for this session.",
      });
    }

    const data = await monimeFetch(
      `/v1/payment-codes/${encodeURIComponent(session.payment.paymentCodeId)}`,
      {
        method: "GET",
        headers: monimeHeaders(),
      }
    );

    const code = data.result;
    const status = code.status || "pending";

    const updated = await updateSession(session.sessionId, {
      step: status === "completed" ? "payment_verified" : "payment_pending",
      status: status === "completed" ? "payment_verified" : "payment_pending",
      payment: {
        ...session.payment,
        status,
        ussdCode: code.ussdCode || session.payment.ussdCode,
        expiresAt: code.expireTime || session.payment.expiresAt,
      },
    });

    return res.json({
      success: true,
      paymentCode: {
        id: code.id,
        status,
        ussdCode: code.ussdCode,
        expiresAt: code.expireTime,
        processedPaymentData: code.processedPaymentData || null,
      },
      session: safeSession(updated),
      message:
        status === "completed"
          ? nextInstructions(updated)
          : paymentMessage(updated),
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message,
      details: error.monimeData || null,
    });
  }
});

/**
 * VERIFY CUSTOMER-SUPPLIED PAYMENT REFERENCE
 *
 * POST /api/ussd/session/:sessionId/verify-reference
 * { reference: "payment-id / order-number / financial-transaction-reference / provider reference" }
 *
 * We do not trust the text the customer enters. The reference is matched
 * against Monime data and the amount/currency are checked against the
 * selected Swift Loan processing fee.
 */
app.post("/api/ussd/session/:sessionId/verify-reference", async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ success: false, error: "Session not found or expired." });

    if (!session.offer || !session.payment) {
      return res.status(400).json({
        success: false,
        error: "This session does not have a pending payment.",
      });
    }

    const reference = String(req.body.reference || "").trim();
    if (!reference || reference.length < 3 || reference.length > 200) {
      return res.status(400).json({
        success: false,
        error: "Enter the payment reference shown by Monime.",
      });
    }

    const payment = await locateMonimePayment(reference);

    if (!payment) {
      return res.status(404).json({
        success: false,
        verified: false,
        error: "Payment reference was not found. Check the reference and try again.",
      });
    }

    const expectedMinor = Math.round(session.offer.fee * 100);

    if (payment.status !== "completed") {
      return res.json({
        success: true,
        verified: false,
        status: payment.status,
        message: `Payment is ${payment.status}. Please wait and try again.`,
      });
    }

    if (payment.amount?.currency !== "SLE" || Number(payment.amount?.value) !== expectedMinor) {
      return res.status(400).json({
        success: false,
        verified: false,
        error: "The payment amount/currency does not match the required Swift Loan processing fee.",
      });
    }

    const paymentMatchesApplication =
      payment.reference === session.payment.reference ||
      payment.metadata?.sessionId === session.sessionId ||
      payment.metadata?.trackingId === session.trackingId ||
      payment.orderNumber === session.payment.orderNumber ||
      payment.financialTransactionReference ===
        session.payment.financialTransactionReference;

    // If Monime has already tied this payment to our payment code, accept it.
    // Otherwise require the payment to match the stored payment-code reference
    // before marking the loan fee as verified.
    if (!paymentMatchesApplication) {
      return res.status(400).json({
        success: false,
        verified: false,
        error:
          "This payment is valid, but it is not linked to this Swift Loan application.",
      });
    }

    const verifiedPayment = {
      paymentId: payment.id,
      status: payment.status,
      reference: payment.reference || null,
      orderNumber: payment.orderNumber || null,
      financialTransactionReference:
        payment.financialTransactionReference || null,
      verifiedAt: new Date().toISOString(),
    };

    const updated = await updateSession(session.sessionId, {
      step: "payment_verified",
      status: "payment_verified",
      verifiedPayment,
      payment: {
        ...session.payment,
        status: "completed",
        paymentId: payment.id,
        orderNumber: payment.orderNumber || null,
        financialTransactionReference:
          payment.financialTransactionReference || null,
      },
    });

    return res.json({
      success: true,
      verified: true,
      session: safeSession(updated),
      message: nextInstructions(updated),
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      verified: false,
      error: error.message,
      details: error.monimeData || null,
    });
  }
});

async function locateMonimePayment(reference) {
  // 1) Treat a value that looks like a Monime payment ID as an ID first.
  // This is the cleanest path when Monime gives the customer the payment ID.
  try {
    const data = await monimeFetch(
      `/v1/payments/${encodeURIComponent(reference)}`,
      {
        method: "GET",
        headers: monimeHeaders(),
      }
    );

    if (data?.result?.id) return data.result;
  } catch {
    // Continue to supported list filters / recent-payment matching.
  }

  // 2) Monime supports list filters for orderNumber and
  // financialTransactionReference.
  for (const [field, value] of [
    ["orderNumber", reference],
    ["financialTransactionReference", reference],
  ]) {
    try {
      const params = new URLSearchParams({
        limit: "50",
        [field]: reference,
      });

      const data = await monimeFetch(`/v1/payments?${params}`, {
        method: "GET",
        headers: monimeHeaders(),
      });

      const match = (data?.result || [])[0];
      if (match) return match;
    } catch {
      // Try the next method.
    }
  }

  // 3) Final fallback: inspect a recent page and compare known reference
  // fields. This covers provider/channel references.
  try {
    const data = await monimeFetch("/v1/payments?limit=50", {
      method: "GET",
      headers: monimeHeaders(),
    });

    const needle = reference.toLowerCase();

    return (
      (data?.result || []).find((payment) => {
        const candidates = [
          payment.id,
          payment.reference,
          payment.orderNumber,
          payment.financialTransactionReference,
          payment.channel?.reference,
        ]
          .filter(Boolean)
          .map((value) => String(value).toLowerCase());

        return candidates.includes(needle);
      }) || null
    );
  } catch {
    return null;
  }
}

/**
 * GENERIC USSD STATE MACHINE ADAPTER
 *
 * This endpoint is intended for the USSD gateway/webhook.
 *
 * POST /api/ussd
 * {
 *   sessionId: "...",       // gateway session ID
 *   phoneNumber: "076123456",
 *   text: "1*2*1"            // cumulative or last input depending on gateway
 * }
 *
 * If your gateway uses a different request/response format, keep the state
 * logic below and adapt only the transport wrapper.
 */
app.post("/api/ussd", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phoneNumber || req.body.phone);
    const input = String(req.body.text ?? "").trim();
    const gatewaySessionId = String(req.body.sessionId || "").trim();

    let session = gatewaySessionId
      ? await getSession(gatewaySessionId)
      : await findLatestSessionByPhone(phone);

    // First request: create a temporary USSD session. The customer must enter
    // ID and phone before an application session is created.
    if (!session) {
      return res.json({
        sessionId: gatewaySessionId || randomUUID(),
        continueSession: true,
        response: "SWIFT LOAN\nWelcome.\n\nEnter your ID number:",
        step: "enter_id",
      });
    }

    // The detailed state machine is deliberately kept separate from the
    // Monime API. This makes it easy to map into the Monime Flow editor.
    return handleUssdInput(session, input, phone, res);
  } catch (error) {
    return res.status(error.status || 400).json({
      continueSession: false,
      response: `Swift Loan\n${error.message}`,
    });
  }
});

async function handleUssdInput(session, input, phone, res) {
  if (session.step === "enter_id") {
    const nationalId = normalizeNationalId(input);

    // We cannot create a real application session until the phone is known.
    const newSessionId = session.sessionId;
    const sessions = await readSessions();

    sessions[newSessionId] = {
      sessionId: newSessionId,
      phone,
      nationalIdHash: hashId(nationalId),
      nationalIdLast4: nationalId.slice(-4),
      step: "offer_selection",
      status: "active",
      trackingId: null,
      offer: null,
      payment: null,
      verifiedPayment: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await writeSessions(sessions);

    return res.json({
      sessionId: newSessionId,
      continueSession: true,
      response: offerMenu(),
      step: "offer_selection",
    });
  }

  if (session.step === "offer_selection") {
    const choice = Number(input);
    const offer = OFFERS[choice - 1];

    if (!offer || !offer.available) {
      return res.json({
        sessionId: session.sessionId,
        continueSession: true,
        response: offerMenu(),
        step: "offer_selection",
      });
    }

    const updated = await updateSession(session.sessionId, {
      trackingId: offer.trackingId,
      offer,
      step: "confirm_offer",
      status: "active",
    });

    return res.json({
      sessionId: session.sessionId,
      continueSession: true,
      response: confirmOfferMessage(updated.offer),
      step: "confirm_offer",
    });
  }

  if (session.step === "confirm_offer") {
    if (input === "1") {
      const fakeReq = {
        params: { sessionId: session.sessionId },
        body: {},
      };

      // Call the same business function without duplicating Monime logic.
      const result = await createPaymentCodeForSession(session.sessionId);
      return res.json({
        sessionId: session.sessionId,
        continueSession: true,
        response: paymentMessage(result),
        step: "payment_pending",
      });
    }

    if (input === "2") {
      return res.json({
        sessionId: session.sessionId,
        continueSession: true,
        response: offerMenu(),
        step: "offer_selection",
      });
    }

    return res.json({
      sessionId: session.sessionId,
      continueSession: true,
      response: confirmOfferMessage(session.offer),
      step: "confirm_offer",
    });
  }

  if (session.step === "payment_pending") {
    if (input === "1") {
      return res.json({
        sessionId: session.sessionId,
        continueSession: true,
        response: paymentMessage(session),
        step: "payment_pending",
      });
    }

    if (input === "2") {
      const updated = await updateSession(session.sessionId, {
        step: "enter_payment_reference",
      });

      return res.json({
        sessionId: session.sessionId,
        continueSession: true,
        response: [
          "SWIFT LOAN",
          `Application: ${updated.trackingId}`,
          "Enter the Monime payment reference:",
        ].join("\n"),
        step: "enter_payment_reference",
      });
    }

    if (input === "3") {
      const refreshed = await refreshPaymentCodeSession(session);
      return res.json({
        sessionId: session.sessionId,
        continueSession: true,
        response:
          refreshed.status === "payment_verified"
            ? nextInstructions(refreshed)
            : paymentMessage(refreshed),
        step: refreshed.step,
      });
    }

    return res.json({
      sessionId: session.sessionId,
      continueSession: true,
      response: paymentMessage(session),
      step: "payment_pending",
    });
  }

  if (session.step === "enter_payment_reference") {
    const payment = await locateMonimePayment(input);

    if (!payment) {
      return res.json({
        sessionId: session.sessionId,
        continueSession: true,
        response:
          "Payment reference not found.\n\nPlease check the reference and enter it again.",
        step: "enter_payment_reference",
      });
    }

    const expectedMinor = Math.round(session.offer.fee * 100);
    const linked =
      payment.reference === session.payment.reference ||
      payment.metadata?.sessionId === session.sessionId ||
      payment.metadata?.trackingId === session.trackingId;

    if (
      payment.status === "completed" &&
      payment.amount?.currency === "SLE" &&
      Number(payment.amount?.value) === expectedMinor &&
      linked
    ) {
      const updated = await updateSession(session.sessionId, {
        step: "payment_verified",
        status: "payment_verified",
        verifiedPayment: {
          paymentId: payment.id,
          status: payment.status,
          reference: payment.reference || null,
          orderNumber: payment.orderNumber || null,
          financialTransactionReference:
            payment.financialTransactionReference || null,
          verifiedAt: new Date().toISOString(),
        },
      });

      return res.json({
        sessionId: session.sessionId,
        continueSession: true,
        response: nextInstructions(updated),
        step: "payment_verified",
      });
    }

    return res.json({
      sessionId: session.sessionId,
      continueSession: true,
      response: `Payment status: ${payment.status}.\n\nThe payment has not been verified for this application yet. Try again.`,
      step: "enter_payment_reference",
    });
  }

  if (session.step === "payment_verified") {
    return res.json({
      sessionId: session.sessionId,
      continueSession: false,
      response: nextInstructions(session),
      step: "payment_verified",
    });
  }

  return res.json({
    sessionId: session.sessionId,
    continueSession: true,
    response: resumeMessage(session),
    step: session.step,
  });
}

async function createPaymentCodeForSession(sessionId) {
  const session = await getSession(sessionId);

  if (!session || !session.offer) {
    throw new Error("No selected loan offer.");
  }

  if (session.payment?.paymentCodeId && session.status === "payment_pending") {
    return session;
  }

  const idempotencyKey = randomUUID();
  const reference = `SWIFT-${session.trackingId}-${session.sessionId.slice(0, 8)}`;

  const data = await monimeFetch("/v1/payment-codes", {
    method: "POST",
    headers: monimeHeaders(idempotencyKey),
    body: JSON.stringify({
      name: `Swift Loan ${session.trackingId} Fee`,
      mode: "one_time",
      enable: true,
      amount: {
        currency: "SLE",
        value: Math.round(session.offer.fee * 100),
      },
      duration: process.env.PAYMENT_CODE_DURATION || "10m",
      customer: { name: "Swift Loan Customer" },
      reference,
      authorizedProviders: providerForPhone(session.phone),
      authorizedPhoneNumber: session.phone,
      metadata: {
        service: "swift_loan",
        trackingId: session.trackingId,
        sessionId: session.sessionId,
        nationalIdLast4: session.nationalIdLast4,
        purpose: "loan_processing_fee",
      },
    }),
  });

  const code = data.result;

  return updateSession(session.sessionId, {
    step: "payment_pending",
    status: "payment_pending",
    payment: {
      paymentCodeId: code.id,
      ussdCode: code.ussdCode,
      amount: session.offer.fee,
      currency: "SLE",
      expiresAt: code.expireTime,
      reference: code.reference || reference,
      status: code.status || "pending",
      createdAt: new Date().toISOString(),
    },
  });
}

async function refreshPaymentCodeSession(session) {
  if (!session.payment?.paymentCodeId) return session;

  const data = await monimeFetch(
    `/v1/payment-codes/${encodeURIComponent(session.payment.paymentCodeId)}`,
    {
      method: "GET",
      headers: monimeHeaders(),
    }
  );

  const code = data.result;
  const status = code.status || "pending";

  return updateSession(session.sessionId, {
    step: status === "completed" ? "payment_verified" : "payment_pending",
    status: status === "completed" ? "payment_verified" : "payment_pending",
    payment: {
      ...session.payment,
      status,
      ussdCode: code.ussdCode || session.payment.ussdCode,
      expiresAt: code.expireTime || session.payment.expiresAt,
    },
  });
}

/**
 * RESUME
 *
 * GET /api/ussd/session/resume?phone=076123456
 */
app.get("/api/ussd/session/resume", async (req, res) => {
  try {
    const session = await findLatestSessionByPhone(req.query.phone);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: "No unfinished Swift Loan session was found.",
      });
    }

    return res.json({
      success: true,
      session: safeSession(session),
      message: resumeMessage(session),
    });
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/ussd/session/:sessionId
 */
app.get("/api/ussd/session/:sessionId", async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: "Session not found or expired.",
      });
    }

    return res.json({
      success: true,
      session: safeSession(session),
      message: resumeMessage(session),
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/loan/offers
 */
app.get("/api/loan/offers", (_req, res) => {
  res.json({
    success: true,
    currency: "SLE",
    offers: OFFERS,
  });
});

app.get("/healthz", (_req, res) => {
  res.json({
    status: "ok",
    service: "swift-loan-ussd",
    currency: "SLE",
    monimeConfigured: Boolean(MONIME_ACCESS_TOKEN && MONIME_SPACE_ID),
  });
});

await ensureStore();

app.listen(PORT, () => {
  console.log(`Swift Loan USSD server running on port ${PORT}`);
});
