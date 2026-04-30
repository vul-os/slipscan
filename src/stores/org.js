import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// Just the active org's ID — the full org list is server state and lives
// in TanStack Query, not here.
export const useOrgStore = create(
  persist(
    (set) => ({
      activeOrgId: null,
      setActiveOrg: (id) => set({ activeOrgId: id }),
    }),
    {
      name: "slipscan.org.v1",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
