<script lang="ts">
  /**
   * Global drag-and-drop capture — "drop a slip anywhere" (ROADMAP.md
   * "Phase 2 ... Slip/receipt capture"). Mounted once in App.svelte,
   * alongside CommandPalette and FirstRun, so a drop lands no matter which
   * screen is open.
   *
   * Two delivery mechanisms, because a Tauri window and a browser tab hand
   * over genuinely different things on a file drop:
   *
   *   - **Under Tauri**, `tauri.conf.json` leaves `dragDropEnabled` at its
   *     default (`true`), so the webview itself intercepts OS file drops
   *     before the DOM ever sees them — a plain `ondrop` handler would fire
   *     with no usable file data. The only path to real, readable absolute
   *     paths is the webview's own event,
   *     `getCurrentWebview().onDragDropEvent()` (`@tauri-apps/api/webview`),
   *     so that is what this uses for the real app. It is also what makes
   *     multi-file import possible without reading every byte through the
   *     UI thread: `document_import` already accepts a `path` as an
   *     alternative to `bytes_base64` (added for the file picker but never
   *     called with one) — this is its first real caller.
   *   - **Outside Tauri** (`vite dev` in a plain browser, and every
   *     Playwright spec — `isTauri` is false there because there is no
   *     `__TAURI_INTERNALS__`), there is no webview to intercept anything,
   *     so standard DOM drag events are both the only mechanism available
   *     and exactly what makes the feature testable at all outside a
   *     packaged build.
   *
   * Import itself does not happen here. A drop hands the normalized file
   * list to Receipts through the same one-shot intent hand-off the command
   * palette's "import a receipt" already uses (`intent.svelte.ts`), so
   * there is exactly one place in the UI layer that calls
   * `api.documentImport` — Receipts.svelte, the file picker's own screen.
   * Unsupported types are rejected there too, by relaying whatever
   * `document_import` itself says: nothing here hand-rolls a second copy of
   * `crates/slipscan-ingest/src/import.rs`'s accepted-extension list.
   */
  import { onMount } from "svelte";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { isTauri } from "../api/client";
  import { requestIntent, type DroppedFile } from "../state/intent.svelte";
  import { router } from "../state/router.svelte";
  import { MAX_IMPORT_BYTES } from "../util/importLimits";
  import Icon from "./Icon.svelte";

  let active = $state(false);

  function toBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function deliver(files: DroppedFile[]): void {
    active = false;
    if (files.length === 0) return;
    requestIntent({ kind: "import-dropped-files", files });
    if (router.current !== "receipts") router.go("receipts");
  }

  /** Reads every dropped file's bytes up front (base64, matching the file
   * picker) except ones already too large to bother — those are handed on
   * as `oversized` so Receipts can report the same reason the picker would
   * have given, without ever holding the bytes in memory. */
  async function filesFromDataTransfer(dt: DataTransfer): Promise<DroppedFile[]> {
    const out: DroppedFile[] = [];
    for (const file of Array.from(dt.files)) {
      if (file.size > MAX_IMPORT_BYTES) {
        out.push({ kind: "oversized", name: file.name, sizeBytes: file.size });
        continue;
      }
      out.push({
        kind: "bytes",
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        bytesBase64: toBase64(await file.arrayBuffer()),
      });
    }
    return out;
  }

  onMount(() => {
    if (isTauri) {
      let unlisten: (() => void) | undefined;
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") {
            active = true;
          } else if (p.type === "drop") {
            deliver(p.paths.map((path) => ({ kind: "path", path })));
          } else {
            active = false;
          }
        })
        .then((fn) => (unlisten = fn));
      return () => unlisten?.();
    }

    // Browser / test fallback: listen on the window, not one screen's own
    // drop zone — "anywhere" is the whole point. `dragenter` fires on every
    // element the pointer crosses, including children of children, so a
    // depth counter is what keeps a nested `dragleave` from hiding the
    // overlay while still technically over the window.
    let depth = 0;
    const hasFiles = (e: DragEvent): boolean =>
      !!e.dataTransfer?.types.includes("Files");
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      active = true;
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
    };
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) active = false;
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      active = false;
      const dt = e.dataTransfer;
      if (!dt) return;
      void filesFromDataTransfer(dt).then(deliver);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  });
</script>

{#if active}
  <!-- Decorative only: a drag-and-drop gesture is mouse/OS-driven, and the
       file picker on Receipts is the accessible path to the exact same
       import — this overlay does not need to be announced to be non-
       stranding. `pointer-events: none` keeps it from ever becoming the
       drop target itself. -->
  <div class="drop-overlay" aria-hidden="true" data-testid="drop-overlay">
    <div class="drop-overlay-panel">
      <Icon name="upload" size={22} class="text-accent-text dark:text-accent" />
      <p class="mt-2 text-[14px] font-semibold">Drop to import</p>
      <p class="mt-1 text-[12px] text-t2">Slips and statements go to Receipts.</p>
    </div>
  </div>
{/if}
