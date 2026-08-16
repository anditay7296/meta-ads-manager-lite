import { create } from "zustand";

const STORAGE_KEY = "sidebar:desktopHidden";

type SidebarState = {
  mobileOpen: boolean;
  desktopHidden: boolean;
  setMobileOpen: (v: boolean) => void;
  toggleMobile: () => void;
  toggleDesktop: () => void;
  hydrate: () => void;
};

export const useSidebar = create<SidebarState>((set) => ({
  mobileOpen: false,
  desktopHidden: false,
  setMobileOpen: (v) => set({ mobileOpen: v }),
  toggleMobile: () => set((s) => ({ mobileOpen: !s.mobileOpen })),
  toggleDesktop: () =>
    set((s) => {
      const next = !s.desktopHidden;
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
        } catch {}
      }
      return { desktopHidden: next };
    }),
  hydrate: () => {
    if (typeof window === "undefined") return;
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      if (v === "1") set({ desktopHidden: true });
    } catch {}
  },
}));
