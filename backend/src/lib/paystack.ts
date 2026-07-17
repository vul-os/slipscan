/**
 * Thin Paystack API client. No SDK — direct fetch with Bearer auth.
 * All ZAR amounts are passed in cents (kobo): R249 = 24900.
 * https://paystack.com/docs/api/
 */
import type { Env } from "../bindings";

const BASE = "https://api.paystack.co";

// ── Internal fetch helper ─────────────────────────────────────────────────────

async function paystackFetch(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const secret = env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error("PAYSTACK_SECRET_KEY is not configured");

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Paystack returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "message" in data
        ? (data as { message: string }).message
        : `Paystack error ${res.status}`;
    throw new Error(msg);
  }

  return data;
}

// ── Initialize transaction ────────────────────────────────────────────────────

export interface InitTransactionParams {
  email: string;
  amount_kobo: number;   // ZAR cents
  plan_code?: string | null;
  metadata?: Record<string, unknown>;
  callback_url?: string;
}

export interface InitTransactionResult {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export async function initializeTransaction(
  env: Env,
  params: InitTransactionParams,
): Promise<InitTransactionResult> {
  const body: Record<string, unknown> = {
    email: params.email,
    amount: params.amount_kobo,
    currency: "ZAR",
    callback_url: params.callback_url,
    metadata: params.metadata ?? {},
  };
  if (params.plan_code) body.plan = params.plan_code;

  const resp = await paystackFetch(env, "/transaction/initialize", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const r = resp as { status: boolean; data: InitTransactionResult };
  if (!r.status || !r.data?.authorization_url) {
    throw new Error("Paystack initialize returned unexpected payload");
  }
  return r.data;
}

// ── Verify transaction ────────────────────────────────────────────────────────

export interface PaystackCustomer {
  id: number;
  email: string;
  customer_code: string;
}

export interface PaystackPlan {
  id: number;
  plan_code: string;
  name: string;
}

export interface PaystackSubscription {
  subscription_code: string;
  next_payment_date: string; // ISO datetime
}

export interface VerifyTransactionResult {
  status: string;           // "success" | "failed" | "abandoned"
  reference: string;
  amount: number;           // kobo
  currency: string;
  customer: PaystackCustomer;
  plan?: PaystackPlan;
  subscription?: PaystackSubscription;
  metadata?: Record<string, unknown>;
}

export async function verifyTransaction(
  env: Env,
  reference: string,
): Promise<VerifyTransactionResult> {
  const resp = await paystackFetch(env, `/transaction/verify/${encodeURIComponent(reference)}`);
  const r = resp as { status: boolean; data: VerifyTransactionResult };
  if (!r.status) throw new Error("Paystack verify returned status=false");
  return r.data;
}

// ── Webhook signature verification ───────────────────────────────────────────
// HMAC-SHA512 of the raw body using PAYSTACK_SECRET_KEY. Web Crypto only.

export async function verifyWebhookSignature(
  env: Env,
  rawBody: string,
  signature: string,
): Promise<boolean> {
  const secret = env.PAYSTACK_SECRET_KEY;
  if (!secret) return false;

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign(
    "HMAC",
    keyMaterial,
    new TextEncoder().encode(rawBody),
  );

  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison to avoid timing attacks.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}
