import { useEffect } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useAuthStore } from "@/stores/auth";

// Standalone redirect target for invite emails. Authenticated users go
// straight to onboarding's "join" tab with the token pre-filled. Logged-
// out users land on /register and we preserve the token via state.
export default function AcceptInvitePage() {
  const [params] = useSearchParams();
  const accessToken = useAuthStore((s) => s.accessToken);
  const token = params.get("token") || "";

  useEffect(() => {
    if (token) sessionStorage.setItem("pendingInviteToken", token);
  }, [token]);

  if (accessToken) {
    return <Navigate to={`/onboarding?tab=join&token=${encodeURIComponent(token)}`} replace />;
  }
  return <Navigate to="/register" replace />;
}
