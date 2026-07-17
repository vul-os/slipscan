/**
 * Theme controller. Dark is first-class; follows the OS by default with a
 * manual override persisted locally. `index.html` applies the class before
 * first paint to avoid flashes.
 */

export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "slipscan.theme";

function loadMode(): ThemeMode {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === "light" || raw === "dark" ? raw : "system";
}

class Theme {
  mode: ThemeMode = $state(loadMode());
  #osDark: boolean = $state(false);
  #mq = window.matchMedia("(prefers-color-scheme: dark)");

  constructor() {
    this.#osDark = this.#mq.matches;
    this.#mq.addEventListener("change", (e) => {
      this.#osDark = e.matches;
      this.#apply();
    });
    this.#apply();
  }

  get resolved(): "dark" | "light" {
    if (this.mode === "system") return this.#osDark ? "dark" : "light";
    return this.mode;
  }

  set(mode: ThemeMode): void {
    this.mode = mode;
    if (mode === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, mode);
    this.#apply();
  }

  #apply(): void {
    document.documentElement.classList.toggle("dark", this.resolved === "dark");
  }
}

export const theme = new Theme();
