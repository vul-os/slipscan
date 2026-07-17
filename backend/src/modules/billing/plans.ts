/**
 * Paystack plan catalog.
 * Plan codes are set via wrangler vars (PAYSTACK_TEAM_PLAN_CODE /
 * PAYSTACK_BUSINESS_PLAN_CODE). The founder creates the plans in the Paystack
 * dashboard and pastes the plan codes into wrangler.toml or via `wrangler secret put`.
 * If env vars are missing the plan is still shown but configured=false and the
 * FE renders "Coming soon" instead of an upgrade button.
 */
import type { Env } from "../../bindings";

export type PlanCode = "free" | "team" | "business";

export interface PlanDef {
  code: PlanCode;
  name: string;
  price_zar: number;
  /** ZAR cents (kobo in Paystack terminology for ZAR). R249 = 24900. */
  price_zar_cents: number;
  features: string[];
}

const PLAN_DEFS: PlanDef[] = [
  {
    code: "free",
    name: "Free",
    price_zar: 0,
    price_zar_cents: 0,
    features: [
      "Up to 50 documents / mo",
      "1 user, 1 org",
      "Personal vault + business ledger",
      "Email-in (1 inbox alias)",
      "Xero export",
    ],
  },
  {
    code: "team",
    name: "Team",
    price_zar: 249,
    price_zar_cents: 24900,
    features: [
      "Up to 500 documents / mo",
      "5 users, 3 orgs",
      "Auto-reconcile with Stitch feeds",
      "Email-in approvals & alerts",
      "Classification learning loop",
      "Priority email support",
    ],
  },
  {
    code: "business",
    name: "Business",
    price_zar: 599,
    price_zar_cents: 59900,
    features: [
      "Up to 2,500 documents / mo",
      "Unlimited users, unlimited orgs",
      "Accountant workspace (one inbox across all clients)",
      "Forecast, anomalies, tax-readiness",
      "Public API + tokens",
      "Audit log export",
    ],
  },
];

export interface PlanWithConfig extends PlanDef {
  paystack_plan_code: string | null;
  configured: boolean;
}

/** Returns all plans, annotated with whether the Paystack plan code env var is set. */
export function getPlans(env: Env): PlanWithConfig[] {
  return PLAN_DEFS.map((p) => {
    let paystack_plan_code: string | null = null;
    if (p.code === "team") {
      paystack_plan_code = env.PAYSTACK_TEAM_PLAN_CODE ?? null;
    } else if (p.code === "business") {
      paystack_plan_code = env.PAYSTACK_BUSINESS_PLAN_CODE ?? null;
    }
    return {
      ...p,
      paystack_plan_code: paystack_plan_code || null,
      configured: p.code === "free" || !!(paystack_plan_code && paystack_plan_code.trim() !== ""),
    };
  });
}

/** Look up a single plan definition (without env). Null if not found. */
export function getPlanDef(code: string): PlanDef | null {
  return PLAN_DEFS.find((p) => p.code === code) ?? null;
}
