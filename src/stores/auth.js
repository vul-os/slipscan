import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// Tokens persist in localStorage so a page refresh keeps you logged in.
// Trade-off: tokens accessible to any script on the origin. Acceptable
// for a v1 internal-feel SaaS; revisit with httpOnly cookies later.
export const useAuthStore = create(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      setSession: (user, tokens) => set({
        user,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
      }),
      setTokens: (tokens) => set({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
      }),
      setUser: (user) => set({ user }),
      logout: () => set({ user: null, accessToken: null, refreshToken: null }),
    }),
    {
      name: "slipscan.auth.v1",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
