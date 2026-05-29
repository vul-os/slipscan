/**
 * "Sign in with Google" — OAuth2 / OpenID Connect, server-side redirect flow.
 * (New capability; the Go backend was email/password only.)
 *
 *   GET /auth/google            -> redirect the user to Google's consent screen
 *   GET /auth/google/callback   -> exchange code, find-or-create the user, issue
 *                                  our JWT pair, redirect to the frontend with
 *                                  the tokens in the URL fragment.
 *
 * CSRF: the `state` param is a short-lived HS256 token signed with JWT_SECRET
 * (stateless — no KV/DB needed). Google-authenticated emails are marked verified.
 */
import { Hono } from "hono";
import { SignJWT, jwtVerify } from "jose";
import type { AppEnv } from "../../types/app";
import { writeError } from "../../lib/errors";
import { issueTokens } from "../../lib/jwt";
import { hashPassword } from "../../lib/password";
import { newRandomToken } from "../../lib/crypto";
import { getUserByEmail, createUser, markVerified, updateUser } from "./queries";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const STATE_TTL_SEC = 600; // 10 min
const ACCESS_TTL = 900;
const REFRESH_TTL = 604800;

const key = (s: string) => new TextEncoder().encode(s);

async function signState(secret: string): Promise<string> {
  return new SignJWT({ p: "google_oauth" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + STATE_TTL_SEC)
    .sign(key(secret));
}
async function verifyState(secret: string, state: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(state, key(secret), { algorithms: ["HS256"] });
    return payload.p === "google_oauth";
  } catch {
    return false;
  }
}

const r = new Hono<AppEnv>();

// GET /auth/google — kick off the OAuth flow.
r.get("/google", async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_REDIRECT_URL) {
    return writeError(c, 503, "google_not_configured", "Google sign-in is not configured");
  }
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: c.env.GOOGLE_REDIRECT_URL,
    response_type: "code",
    scope: "openid email profile",
    state: await signState(c.env.JWT_SECRET),
    access_type: "online",
    prompt: "select_account",
  });
  return c.redirect(`${AUTH_URL}?${params.toString()}`);
});

// GET /auth/google/callback — Google redirects here with ?code & ?state.
r.get("/google/callback", async (c) => {
  const front = c.env.FRONTEND_BASE_URL ?? "";
  const fail = (reason: string) => c.redirect(`${front}/auth/callback#error=${encodeURIComponent(reason)}`);

  if (c.req.query("error")) return fail(c.req.query("error") as string);
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return fail("missing_code");
  if (!(await verifyState(c.env.JWT_SECRET, state))) return fail("bad_state");
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET || !c.env.GOOGLE_REDIRECT_URL) {
    return writeError(c, 503, "google_not_configured", "Google sign-in is not configured");
  }

  // 1. Exchange the auth code for tokens.
  const tokRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: c.env.GOOGLE_REDIRECT_URL,
      grant_type: "authorization_code",
    }),
  });
  if (!tokRes.ok) return fail("token_exchange_failed");
  const tokJson = (await tokRes.json()) as { access_token?: string };
  if (!tokJson.access_token) return fail("no_access_token");

  // 2. Fetch the user's profile.
  const uiRes = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokJson.access_token}` } });
  if (!uiRes.ok) return fail("userinfo_failed");
  const profile = (await uiRes.json()) as { email?: string; email_verified?: boolean; name?: string; picture?: string };
  const email = (profile.email ?? "").trim().toLowerCase();
  if (!email) return fail("no_email");

  const googlePicture = typeof profile.picture === "string" && profile.picture ? profile.picture : undefined;

  // 3. Find-or-create the user. New OAuth users get a random, unusable password
  //    hash (they sign in via Google; can set a password later via reset).
  let user = await getUserByEmail(c.env, email);
  if (!user) {
    const unusable = await hashPassword(newRandomToken() + newRandomToken());
    user = await createUser(c.env, email, unusable, profile.name ?? "");
    if (profile.email_verified !== false) {
      try {
        await markVerified(c.env, user.id);
      } catch {
        /* non-fatal */
      }
    }
    // Persist the Google profile picture for new users.
    if (googlePicture) {
      try {
        const updated = await updateUser(c.env, user.id, { avatar_url: googlePicture });
        if (updated) user = updated;
      } catch {
        /* non-fatal */
      }
    }
  } else if (googlePicture && !user.avatar_url) {
    // Backfill avatar_url for existing Google users who signed in before this feature.
    try {
      const updated = await updateUser(c.env, user.id, { avatar_url: googlePicture });
      if (updated) user = updated;
    } catch {
      /* non-fatal */
    }
  }

  // 4. Issue our JWT pair and hand it to the frontend via the URL fragment.
  const tokens = await issueTokens(c.env.JWT_SECRET, user.id, user.email, ACCESS_TTL, REFRESH_TTL);
  return c.redirect(
    `${front}/auth/callback#access_token=${encodeURIComponent(tokens.access_token)}` +
      `&refresh_token=${encodeURIComponent(tokens.refresh_token)}`,
  );
});

export default r;
