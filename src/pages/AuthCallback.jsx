// OAuth callback handler — reads tokens (or error) from the URL hash that
// the worker injects after a successful Google consent, then mirrors exactly
// what Login does on success: stores the session and navigates to /dashboard.

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Card, CardBody } from "@/components/ui/Card";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

export default function AuthCallbackPage() {
  const navigate = useNavigate();
  const setTokens = useAuthStore((s) => s.setTokens);
  const setSession = useAuthStore((s) => s.setSession);
  const [errorMsg, setErrorMsg] = useState(null);

  useEffect(() => {
    // Parse hash fragment: worker redirects to /auth/callback#access_token=...&refresh_token=...
    const hash = window.location.hash.replace(/^#/, "");
    const hashParams = new URLSearchParams(hash);

    // Also check query string for ?error=... (some OAuth providers use this)
    const searchParams = new URLSearchParams(window.location.search);

    const error = hashParams.get("error") || searchParams.get("error");
    if (error) {
      setErrorMsg(decodeURIComponent(error));
      return;
    }

    const accessToken = hashParams.get("access_token");
    const refreshToken = hashParams.get("refresh_token");

    if (!accessToken || !refreshToken) {
      setErrorMsg("Authentication failed — no tokens received.");
      return;
    }

    // Store tokens immediately so the api.me() call below is authenticated.
    setTokens({ access_token: accessToken, refresh_token: refreshToken });

    // Clean the hash from the URL before navigating (don't expose tokens in history).
    window.history.replaceState(null, "", window.location.pathname);

    // Mirror Login: fetch /me to populate the user object, then setSession and go to /dashboard.
    api.me()
      .then((user) => {
        setSession(user, { access_token: accessToken, refresh_token: refreshToken });
        navigate("/dashboard", { replace: true });
      })
      .catch(() => {
        // /me failed but we have valid tokens — navigate anyway; the app shell
        // will re-fetch the user when it mounts.
        navigate("/dashboard", { replace: true });
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (errorMsg) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink-50 p-4">
        <Card className="w-full max-w-sm">
          <CardBody className="space-y-4">
            <h2 className="text-base font-medium text-ink-900">Sign-in failed</h2>
            <p className="text-sm text-ink-500">{errorMsg}</p>
            <Link
              to="/login"
              className="text-sm text-ink-900 underline underline-offset-4 decoration-ink-300 hover:decoration-ink-700"
            >
              Back to sign in
            </Link>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-ink-50">
      <p className="text-sm text-ink-500">Signing you in&hellip;</p>
    </div>
  );
}
