/**
 * Stitch provider — port of backend/internal/bankfeed/stitch.go.
 *
 * Live HTTP calls to Stitch (https://stitch.money).
 * Gated: when STITCH_CLIENT_ID is unset the caller returns 503.
 *
 * OAuth2 + PKCE for account linking (bank-link modal).
 * Transactions via Stitch GraphQL API (https://api.stitch.money/graphql).
 * Webhooks: HMAC-SHA256 in X-Stitch-Signature header (Web Crypto API).
 */
import type { Env } from "../../bindings";
import type { LinkedAccount, ProviderTransaction } from "./types";

const STITCH_AUTH_URL = "https://secure.stitch.money/connect/authorize";
const STITCH_TOKEN_URL = "https://secure.stitch.money/connect/token";
const STITCH_GRAPHQL_URL = "https://api.stitch.money/graphql";

// ─── Config guard ──────────────────────────────────────────────────────────────

export function stitchConfigured(env: Env): boolean {
  return Boolean(env.STITCH_CLIENT_ID);
}

// ─── Link URL (OAuth2 authorize) ───────────────────────────────────────────────

/**
 * linkURL — port of StitchProvider.LinkURL.
 * Builds the Stitch OAuth2 authorization URL with state + nonce (orgId).
 */
export function linkURL(env: Env, orgId: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.STITCH_CLIENT_ID!,
    redirect_uri: env.STITCH_REDIRECT_URL ?? "",
    scope: "accounts transactions balances identity openid offline_access",
    state,
    nonce: orgId,
  });
  return `${STITCH_AUTH_URL}?${params.toString()}`;
}

// ─── Token exchange ────────────────────────────────────────────────────────────

export interface TokenResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO-8601
}

/**
 * exchangeCode — port of StitchProvider.ExchangeCode.
 * Returns linked accounts + token material.
 */
export async function exchangeCode(
  env: Env,
  code: string,
): Promise<{ accounts: LinkedAccount[] } & TokenResult> {
  const tok = await doTokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: env.STITCH_REDIRECT_URL ?? "",
    client_id: env.STITCH_CLIENT_ID!,
    client_secret: env.STITCH_CLIENT_SECRET ?? "",
  });

  const accounts = await fetchAccounts(env, tok.accessToken);
  return { accounts, ...tok };
}

/**
 * refreshToken — port of StitchProvider.RefreshToken.
 */
export async function refreshAccessToken(
  env: Env,
  refreshToken: string,
): Promise<TokenResult> {
  return doTokenRequest(env, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.STITCH_CLIENT_ID!,
    client_secret: env.STITCH_CLIENT_SECRET ?? "",
  });
}

async function doTokenRequest(
  env: Env,
  params: Record<string, string>,
): Promise<TokenResult> {
  const body = new URLSearchParams(params).toString();
  const resp = await fetch(STITCH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`stitch: token request ${resp.status}: ${text}`);
  }
  const data = (await resp.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
  };
}

// ─── Accounts ──────────────────────────────────────────────────────────────────

/**
 * fetchAccounts — port of StitchProvider.Accounts.
 */
export async function fetchAccounts(
  env: Env,
  accessToken: string,
): Promise<LinkedAccount[]> {
  const gql = `{
    user {
      bankAccounts {
        id name currency accountType bankId branchCode accountNumber
      }
    }
  }`;

  const data = await gqlQuery<{
    user: {
      bankAccounts: Array<{
        id: string;
        name: string;
        currency: string;
        accountType: string;
        bankId: string;
        branchCode: string;
        accountNumber: string;
      }>;
    };
  }>(accessToken, gql, undefined);

  return data.user.bankAccounts.map((a) => {
    const mask = a.accountNumber.length >= 4
      ? a.accountNumber.slice(-4)
      : "";
    return {
      providerAccountId: a.id,
      providerItemId: a.id, // Stitch: account = item (one-to-one)
      institutionId: a.bankId,
      institutionName: bankIdToName(a.bankId),
      mask,
      currency: a.currency,
      accountType: a.accountType,
    };
  });
}

// ─── Transactions ──────────────────────────────────────────────────────────────

/**
 * fetchTransactions — port of StitchProvider.FetchTransactions.
 * Returns [transactions, nextCursor]. nextCursor="" when exhausted.
 */
export async function fetchTransactions(
  accessToken: string,
  providerAccountId: string,
  from: string,
  to: string,
  cursor: string,
): Promise<[ProviderTransaction[], string]> {
  const query = `
    query Transactions($accountId: ID!, $first: Int!, $after: String, $fromDate: Date, $toDate: Date) {
      node(id: $accountId) {
        ... on BankAccount {
          transactions(first: $first, after: $after, filter: { date: { gte: $fromDate, lte: $toDate } }) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                amount { quantity currency }
                description
                date
                runningBalance { quantity currency }
                transactionType
              }
            }
          }
        }
      }
    }`;

  const variables: Record<string, unknown> = {
    accountId: providerAccountId,
    first: 100,
    fromDate: from,
    toDate: to,
  };
  if (cursor) variables.after = cursor;

  interface TxNode {
    id: string;
    amount: { quantity: number; currency: string };
    description: string;
    date: string;
    runningBalance: { quantity: number; currency: string };
    transactionType: string;
  }
  interface GqlData {
    node: {
      transactions: {
        pageInfo: { hasNextPage: boolean; endCursor: string };
        edges: Array<{ node: TxNode }>;
      };
    };
  }

  const data = await gqlQuery<GqlData>(accessToken, query, variables);
  const conn = data.node.transactions;

  const txns: ProviderTransaction[] = conn.edges.map(({ node: n }) => {
    const dir = n.amount.quantity >= 0 ? "credit" : "debit";
    const amt = Math.abs(n.amount.quantity);
    const bal = n.runningBalance.quantity !== 0 ? n.runningBalance.quantity : null;
    return {
      providerTxnId: n.id,
      date: n.date,
      description: n.description,
      amount: amt,
      currency: n.amount.currency,
      direction: dir,
      balance: bal,
      raw: {
        id: n.id,
        transactionType: n.transactionType,
        date: n.date,
        amount: n.amount,
        runningBalance: n.runningBalance,
      },
    };
  });

  const nextCursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : "";
  return [txns, nextCursor];
}

// ─── Webhook ───────────────────────────────────────────────────────────────────

/**
 * webhookEventType — port of StitchProvider.WebhookEventType.
 * Extracts the top-level "type" field from the Stitch webhook payload.
 */
export function webhookEventType(payload: Uint8Array): string {
  const text = new TextDecoder().decode(payload);
  const body = JSON.parse(text) as { type?: string };
  return body.type ?? "";
}

/**
 * validateWebhook — port of StitchProvider.ValidateWebhook.
 * HMAC-SHA256 of the raw body using STITCH_WEBHOOK_SECRET.
 * Uses the Web Crypto API (available in all Workers runtimes).
 */
export async function validateWebhook(
  payload: Uint8Array,
  sig: string,
  secret: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, payload);
  const expected = bufToHex(new Uint8Array(mac));
  // Constant-time compare via XOR over hex strings (same length always).
  return constantTimeEqual(sig.toLowerCase(), expected);
}

function bufToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ─── GraphQL helper ────────────────────────────────────────────────────────────

async function gqlQuery<T>(
  accessToken: string,
  query: string,
  variables: Record<string, unknown> | undefined,
): Promise<T> {
  const payload: Record<string, unknown> = { query };
  if (variables !== undefined) payload.variables = variables;

  const resp = await fetch(STITCH_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`stitch: gql ${resp.status}: ${text}`);
  }

  const body = (await resp.json()) as { data: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) {
    throw new Error(`stitch: gql error: ${body.errors[0].message}`);
  }
  return body.data;
}

// ─── Bank name map ─────────────────────────────────────────────────────────────

function bankIdToName(id: string): string {
  const names: Record<string, string> = {
    fnb: "FNB / First National Bank",
    absa: "ABSA Bank",
    standard_bank: "Standard Bank",
    nedbank: "Nedbank",
    capitec: "Capitec Bank",
    investec: "Investec Bank",
    tymebank: "TymeBank",
    discovery_bank: "Discovery Bank",
    african_bank: "African Bank",
    bidvest_bank: "Bidvest Bank",
    grindrod_bank: "Grindrod Bank",
  };
  return names[id] ?? id;
}
