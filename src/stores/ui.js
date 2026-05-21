import { create } from "zustand";

// Tiny UI store for cross-cutting overlays (upload, command palette).
// Keeping these in zustand means any component — sidebar, palette,
// page-level button, keyboard shortcut — can trigger them without
// prop-drilling state through AppLayout.
export const useUIStore = create((set) => ({
  uploadOpen: false,
  paletteOpen: false,
  setUploadOpen: (open) => set({ uploadOpen: open }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
}));
